/**
 * Writer agent for Agent Mesh.
 *
 * Synthesizes research findings into professional reports using LLMs
 * through Locus wrapped APIs. Each API call is billed in USDC.
 *
 * Provider priority: Gemini (primary) → Grok (fallback) → static summary.
 */
const BaseAgent = require('./base-agent');

// LLM provider configuration
const GEMINI_MODEL = 'gemini-2.5-flash';
const GROK_MODEL = 'grok-3-mini-fast';
const MAX_OUTPUT_TOKENS = 4096;
const SYNTHESIS_TEMPERATURE = 0.7;

// Content truncation limits to fit within LLM context windows
const PRIMARY_TRUNCATE_LIMIT = 3000;
const SUPPLEMENTARY_TRUNCATE_LIMIT = 2000;

/** LLM providers to try in order of preference. */
const LLM_PROVIDERS = [
  {
    name: 'gemini',
    endpoint: 'chat',
    buildBody: (prompt) => ({
      model: GEMINI_MODEL,
      systemInstruction: 'You are a professional report writer. Produce clear, well-structured reports with actionable takeaways.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: SYNTHESIS_TEMPERATURE,
    }),
  },
  {
    name: 'grok',
    endpoint: 'chat',
    buildBody: (prompt) => ({
      model: GROK_MODEL,
      messages: [
        { role: 'system', content: 'You are a professional report writer. Produce clear, well-structured reports with actionable takeaways.' },
        { role: 'user', content: prompt },
      ],
    }),
  },
];

class WriterAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'writer' });
  }

  /**
   * Synthesize research findings into a professional report.
   * Tries LLM providers in order; falls back to a static summary
   * if all providers fail (e.g. due to insufficient wallet balance).
   * @param {Array<object>} researchFindings - Research results from ResearchAgent
   * @param {string} outputFormat - Output format (default: 'report')
   * @returns {object} Report with content, provider used, and metadata
   */
  async synthesize(researchFindings, outputFormat = 'report') {
    this.log('synthesis_started', {
      inputSources: researchFindings.length,
      format: outputFormat,
    });

    const prompt = this._buildPrompt(researchFindings, outputFormat);

    // Try each LLM provider in order
    for (const provider of LLM_PROVIDERS) {
      try {
        const result = await this.callAPI(provider.name, provider.endpoint, provider.buildBody(prompt));
        this.log('synthesis_completed', { provider: provider.name, format: outputFormat });

        const content = this._extractContent(result);
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

    // All providers failed — produce a static summary
    this.log('synthesis_fallback_used', { reason: 'All LLM providers failed' });
    return {
      report: this._fallbackSummary(researchFindings),
      format: outputFormat,
      provider: 'fallback',
      sourcesUsed: researchFindings.length,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Extract the generated text from a Locus wrapped API response.
   * Handles different response shapes from Gemini and Grok.
   */
  _extractContent(result) {
    const apiData = result.data?.data || result.data;
    return apiData?.choices?.[0]?.message?.content        // Grok / OpenAI format
      || apiData?.candidates?.[0]?.content?.parts?.[0]?.text // Gemini format
      || apiData?.result
      || (typeof apiData === 'string' ? apiData : JSON.stringify(apiData));
  }

  /** Build the synthesis prompt from research findings. */
  _buildPrompt(findings, format) {
    const sections = findings.map((f, i) => {
      let content = `## Source ${i + 1}: ${f.query}\n`;
      if (f.scrapedData) {
        content += `Scraped content (via Firecrawl):\n${this._truncate(f.scrapedData, PRIMARY_TRUNCATE_LIMIT)}\n\n`;
      }
      if (f.searchResults) {
        content += `Search results (via Exa):\n${this._truncate(f.searchResults, PRIMARY_TRUNCATE_LIMIT)}\n\n`;
      }
      if (f.supplementaryResults) {
        content += `Supplementary results (via Firecrawl):\n${this._truncate(f.supplementaryResults, SUPPLEMENTARY_TRUNCATE_LIMIT)}\n\n`;
      }
      return content;
    });

    const today = new Date().toISOString().split('T')[0];
    return `Based on the following research findings, create a clear, professional ${format} with key insights and actionable takeaways.

IMPORTANT: Do NOT use placeholder text like "[Your Name]", "[Current Date]", "[Your Contact Information]", or "[Link]". Instead:
- Use "Agent Mesh Research Team" as the author
- Use "${today}" as the date
- For source links, use the actual URLs from the research data if available, or omit the links section
- Do not include a contact information line

Research findings:\n\n${sections.join('\n')}`;
  }

  /** Truncate data to a character limit, handling both strings and objects. */
  _truncate(data, limit) {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    return str.slice(0, limit);
  }

  /** Generate a static summary when no LLM provider is available. */
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
