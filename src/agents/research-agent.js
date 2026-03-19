const BaseAgent = require('./base-agent');

class ResearchAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'researcher' });
  }

  async research(query) {
    this.log('research_started', { query });

    let scrapedData = null;
    let searchResults = null;

    // If query is a URL, scrape it. Otherwise use search APIs.
    const isUrl = query.startsWith('http://') || query.startsWith('https://');

    if (isUrl) {
      try {
        const scrapeResult = await this.callAPI('firecrawl', 'scrape', {
          url: query,
          formats: ['markdown'],
        });
        scrapedData = scrapeResult.data;
        this.log('scrape_completed', { source: query });
      } catch (err) {
        this.log('scrape_failed', { error: err.message });
      }
    }

    // Always run a search
    // Try Exa first
    try {
      const exaResult = await this.callAPI('exa', 'search', {
        query: isUrl ? `site:${query}` : query,
        numResults: 5,
      });
      searchResults = exaResult.data;
      this.log('exa_search_completed', { resultCount: 5 });
    } catch (err) {
      this.log('exa_search_failed', { error: err.message });

      // Fallback: try Grok web search
      try {
        const grokResult = await this.callAPI('grok', 'web-search', {
          query,
        });
        searchResults = grokResult.data;
        this.log('grok_search_completed', { query });
      } catch (err2) {
        this.log('grok_search_failed', { error: err2.message });
      }
    }

    // Try Firecrawl search as another option
    if (!searchResults && !isUrl) {
      try {
        const fcResult = await this.callAPI('firecrawl', 'search', {
          query,
          limit: 5,
        });
        searchResults = fcResult.data;
        this.log('firecrawl_search_completed', { query });
      } catch (err) {
        this.log('firecrawl_search_failed', { error: err.message });
      }
    }

    const findings = {
      query,
      scrapedData,
      searchResults,
      timestamp: new Date().toISOString(),
    };

    this.log('research_completed', {
      query,
      hasScrapedData: !!scrapedData,
      hasSearchResults: !!searchResults,
    });
    return findings;
  }
}

module.exports = ResearchAgent;
