const BaseAgent = require('./base-agent');

class ResearchAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'researcher' });
  }

  async research(query) {
    this.log('research_started', { query });

    let scrapedData = null;
    let searchResults = null;
    let supplementaryResults = null;

    // If query is a URL, scrape it via Firecrawl
    const isUrl = query.startsWith('http://') || query.startsWith('https://');

    if (isUrl) {
      try {
        const scrapeResult = await this.callAPI('firecrawl', 'scrape', {
          url: query,
          formats: ['markdown'],
        });
        scrapedData = scrapeResult.data;
        this.log('firecrawl_scrape_completed', { source: query });
      } catch (err) {
        this.log('firecrawl_scrape_failed', { error: err.message });
      }
    }

    // Primary search via Exa (semantic search)
    try {
      const exaResult = await this.callAPI('exa', 'search', {
        query: isUrl ? `site:${query}` : query,
        numResults: 5,
      });
      searchResults = exaResult.data;
      this.log('exa_search_completed', { resultCount: 5 });
    } catch (err) {
      this.log('exa_search_failed', { error: err.message });
    }

    // Supplementary search via Firecrawl (web scraping search)
    if (!isUrl) {
      try {
        const fcResult = await this.callAPI('firecrawl', 'search', { query });
        supplementaryResults = fcResult.data;
        this.log('firecrawl_search_completed', { query });
      } catch (err) {
        // Firecrawl search is supplementary, don't log failure to timeline
      }
    }

    // Fallback if neither Exa nor Firecrawl returned results
    if (!searchResults && !supplementaryResults) {
      try {
        const grokResult = await this.callAPI('grok', 'web-search', {
          model: 'grok-3-mini-fast',
          messages: [{ role: 'user', content: `Search the web for: ${query}` }],
        });
        searchResults = grokResult.data;
        this.log('grok_search_completed', { query });
      } catch (err) {
        this.log('grok_search_failed', { error: err.message });
      }
    }

    const findings = {
      query,
      scrapedData,
      searchResults,
      supplementaryResults,
      timestamp: new Date().toISOString(),
    };

    this.log('research_completed', {
      query,
      hasScrapedData: !!scrapedData,
      hasSearchResults: !!searchResults,
      hasSupplementary: !!supplementaryResults,
      providers: [scrapedData && 'firecrawl-scrape', searchResults && 'exa', supplementaryResults && 'firecrawl-search'].filter(Boolean),
    });
    return findings;
  }
}

module.exports = ResearchAgent;
