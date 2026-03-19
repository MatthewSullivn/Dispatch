/**
 * Research agent for Agent Mesh.
 *
 * Searches the web using multiple data sources through Locus wrapped APIs:
 *   - Exa: semantic search (primary)
 *   - Firecrawl: web scraping and search (supplementary)
 *   - Grok: AI-powered web search (fallback)
 *
 * Each API call is billed in USDC to this agent's Locus wallet.
 * Returns structured findings for the writer agent to synthesize.
 */
const BaseAgent = require('./base-agent');

const EXA_RESULT_LIMIT = 5;
const CONTENT_TRUNCATE_LIMIT = 3000;
const SUPPLEMENTARY_TRUNCATE_LIMIT = 2000;

class ResearchAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'researcher' });
  }

  /**
   * Research a query using multiple search providers.
   * If the query is a URL, scrapes it directly via Firecrawl.
   * Otherwise runs semantic search (Exa) + supplementary search (Firecrawl).
   * Falls back to Grok web-search if neither returns results.
   * @param {string} query - Search query or URL to research
   * @returns {object} Findings with scrapedData, searchResults, supplementaryResults
   */
  async research(query) {
    this.log('research_started', { query });

    const isUrl = query.startsWith('http://') || query.startsWith('https://');
    const scrapedData = isUrl ? await this._scrapeUrl(query) : null;
    const searchResults = await this._searchExa(query, isUrl);
    const supplementaryResults = !isUrl ? await this._searchFirecrawl(query) : null;

    // Fallback to Grok only if both primary sources returned nothing
    const finalSearch = (!searchResults && !supplementaryResults)
      ? await this._searchGrokFallback(query)
      : searchResults;

    const findings = {
      query,
      scrapedData,
      searchResults: finalSearch,
      supplementaryResults,
      timestamp: new Date().toISOString(),
    };

    this.log('research_completed', {
      query,
      hasScrapedData: !!scrapedData,
      hasSearchResults: !!finalSearch,
      hasSupplementary: !!supplementaryResults,
      providers: [scrapedData && 'firecrawl-scrape', finalSearch && 'exa', supplementaryResults && 'firecrawl-search'].filter(Boolean),
    });

    return findings;
  }

  // ── Private: Search providers ──────────────────────────────────

  /** Scrape a URL directly via Firecrawl. */
  async _scrapeUrl(url) {
    try {
      const result = await this.callAPI('firecrawl', 'scrape', { url, formats: ['markdown'] });
      this.log('firecrawl_scrape_completed', { source: url });
      return result.data;
    } catch (err) {
      this.log('firecrawl_scrape_failed', { error: err.message });
      return null;
    }
  }

  /** Primary semantic search via Exa. */
  async _searchExa(query, isUrl) {
    try {
      const result = await this.callAPI('exa', 'search', {
        query: isUrl ? `site:${query}` : query,
        numResults: EXA_RESULT_LIMIT,
      });
      this.log('exa_search_completed', { resultCount: EXA_RESULT_LIMIT });
      return result.data;
    } catch (err) {
      this.log('exa_search_failed', { error: err.message });
      return null;
    }
  }

  /** Supplementary web search via Firecrawl. */
  async _searchFirecrawl(query) {
    try {
      const result = await this.callAPI('firecrawl', 'search', { query });
      this.log('firecrawl_search_completed', { query });
      return result.data;
    } catch (err) {
      this.log('firecrawl_search_skipped', { reason: 'supplementary search unavailable', error: err.message });
      return null;
    }
  }

  /** Fallback search via Grok when both Exa and Firecrawl fail. */
  async _searchGrokFallback(query) {
    try {
      const result = await this.callAPI('grok', 'web-search', {
        model: 'grok-3-mini-fast',
        messages: [{ role: 'user', content: `Search the web for: ${query}` }],
      });
      this.log('grok_search_completed', { query });
      return result.data;
    } catch (err) {
      this.log('grok_search_failed', { error: err.message });
      return null;
    }
  }
}

module.exports = ResearchAgent;
