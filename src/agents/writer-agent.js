const BaseAgent = require('./base-agent');

class WriterAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'writer' });
  }

  async synthesize(researchFindings, outputFormat = 'report') {
    this.log('synthesis_started', {
      inputSources: researchFindings.length,
      format: outputFormat,
    });

    const prompt = this._buildPrompt(researchFindings, outputFormat);

    // Try multiple LLM providers via Locus wrapped APIs
    const providers = [
      { name: 'gemini', endpoint: 'chat', body: { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: prompt }] } },
      { name: 'grok', endpoint: 'chat', body: { model: 'grok-3-mini-fast', messages: [{ role: 'system', content: 'You are a professional report writer.' }, { role: 'user', content: prompt }] } },
    ];

    for (const provider of providers) {
      try {
        const result = await this.callAPI(provider.name, provider.endpoint, provider.body);
        this.log('synthesis_completed', { provider: provider.name, format: outputFormat });

        // Locus wraps responses in { success, data: { ...provider response } }
        const apiData = result.data?.data || result.data;
        const content = apiData?.choices?.[0]?.message?.content
          || apiData?.candidates?.[0]?.content?.parts?.[0]?.text
          || apiData?.result
          || (typeof apiData === 'string' ? apiData : JSON.stringify(apiData));

        return {
          report: content,
          format: outputFormat,
          provider: provider.name,
          sourcesUsed: researchFindings.length,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        this.log('synthesis_provider_failed', { provider: provider.name, error: err.message });
      }
    }

    // Fallback: produce a structured summary without API
    this.log('synthesis_fallback_used');
    return {
      report: this._fallbackSummary(researchFindings),
      format: outputFormat,
      provider: 'fallback',
      sourcesUsed: researchFindings.length,
      timestamp: new Date().toISOString(),
    };
  }

  _buildPrompt(findings, format) {
    const sections = findings.map((f, i) => {
      let content = `## Source ${i + 1}: ${f.query}\n`;
      if (f.scrapedData) {
        const scraped = typeof f.scrapedData === 'string'
          ? f.scrapedData.slice(0, 3000)
          : JSON.stringify(f.scrapedData).slice(0, 3000);
        content += `Scraped content:\n${scraped}\n\n`;
      }
      if (f.searchResults) {
        const search = typeof f.searchResults === 'string'
          ? f.searchResults.slice(0, 3000)
          : JSON.stringify(f.searchResults).slice(0, 3000);
        content += `Search results:\n${search}\n\n`;
      }
      return content;
    });

    return `Based on the following research findings, create a clear, professional ${format} with key insights and actionable takeaways:\n\n${sections.join('\n')}`;
  }

  _fallbackSummary(findings) {
    const sections = findings.map((f, i) => {
      let section = `## Finding ${i + 1}: ${f.query}\n`;
      if (f.scrapedData) section += '- Web data collected successfully\n';
      if (f.searchResults) section += '- Search results obtained\n';
      if (!f.scrapedData && !f.searchResults) section += '- No data collected (insufficient balance)\n';
      return section;
    });

    return `# Research Report\n\n${sections.join('\n')}\n\n---\nGenerated at: ${new Date().toISOString()}\nNote: Full synthesis requires funded Locus wallet for LLM API access.`;
  }
}

module.exports = WriterAgent;
