/**
 * Validator agent for Dispatch.
 *
 * Fact-checks research findings before synthesis using LLMs
 * through Locus wrapped APIs. Each API call is billed in USDC.
 *
 * The validator adds a quality gate between research and writing,
 * ensuring the orchestrator only pays for accurate information.
 *
 * Provider priority: Grok (primary) → Gemini (fallback) → pass-through.
 */
const BaseAgent = require('./base-agent');

const GROK_MODEL = 'grok-3-mini-fast';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_OUTPUT_TOKENS = 2048;

/** LLM providers to try in order. */
const LLM_PROVIDERS = [
  {
    name: 'grok',
    endpoint: 'chat',
    buildBody: (prompt) => ({
      model: GROK_MODEL,
      messages: [
        { role: 'system', content: 'You are a fact-checking agent. Evaluate research findings for accuracy, flag unsupported claims, and rate overall confidence. Be concise.' },
        { role: 'user', content: prompt },
      ],
    }),
  },
  {
    name: 'gemini',
    endpoint: 'chat',
    buildBody: (prompt) => ({
      model: GEMINI_MODEL,
      systemInstruction: 'You are a fact-checking agent. Evaluate research findings for accuracy, flag unsupported claims, and rate overall confidence. Be concise.',
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    }),
  },
];

class ValidatorAgent extends BaseAgent {
  constructor(config) {
    super({ ...config, role: 'validator' });
  }

  /**
   * Validate research findings for accuracy and completeness.
   * Returns a validation report with confidence score and flagged issues.
   * @param {Array<object>} researchFindings - Research results to validate
   * @returns {object} Validation result with score, issues, and validated findings
   */
  async validate(researchFindings) {
    this.log('validation_started', {
      inputSources: researchFindings.length,
    });

    const prompt = this._buildPrompt(researchFindings);

    for (const provider of LLM_PROVIDERS) {
      try {
        const result = await this.callAPI(provider.name, provider.endpoint, provider.buildBody(prompt));
        this.log('validation_completed', { provider: provider.name });

        const content = this._extractContent(result);
        return {
          validated: true,
          report: content,
          provider: provider.name,
          sourcesChecked: researchFindings.length,
          timestamp: new Date().toISOString(),
        };
      } catch (err) {
        this.log('validation_provider_failed', { provider: provider.name, error: err.message });
      }
    }

    // All providers failed — pass through without validation
    this.log('validation_skipped', { reason: 'All LLM providers failed, passing findings through unvalidated' });
    return {
      validated: false,
      report: 'Validation skipped — LLM providers unavailable.',
      provider: 'passthrough',
      sourcesChecked: researchFindings.length,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Private ────────────────────────────────────────────────────

  /** Extract text from a Locus wrapped API response. */
  _extractContent(result) {
    const apiData = result.data?.data || result.data;
    return apiData?.choices?.[0]?.message?.content
      || apiData?.candidates?.[0]?.content?.parts?.[0]?.text
      || apiData?.result
      || (typeof apiData === 'string' ? apiData : JSON.stringify(apiData));
  }

  /** Build the fact-checking prompt from research findings. */
  _buildPrompt(findings) {
    const sections = findings.map((f, i) => {
      let content = `## Source ${i + 1}: ${f.query}\n`;
      if (f.scrapedData) {
        const str = typeof f.scrapedData === 'string' ? f.scrapedData : JSON.stringify(f.scrapedData);
        content += `Scraped data:\n${str.slice(0, 2000)}\n\n`;
      }
      if (f.searchResults) {
        const str = typeof f.searchResults === 'string' ? f.searchResults : JSON.stringify(f.searchResults);
        content += `Search results:\n${str.slice(0, 2000)}\n\n`;
      }
      return content;
    });

    return `Fact-check the following research findings. For each source:
1. Rate confidence (high/medium/low)
2. Flag any claims that seem unsupported or outdated
3. Note if key information is missing
4. Give an overall quality score (1-10)

Research findings:\n\n${sections.join('\n')}

Respond in this format:
**Overall Quality:** X/10
**Confidence:** high/medium/low
**Issues Found:** (list or "none")
**Recommendation:** proceed / needs more research`;
  }
}

module.exports = ValidatorAgent;
