/**
 * Locus API client for Dispatch.
 *
 * Wraps the Locus payment infrastructure API:
 *   - Wallet balance and USDC transfers
 *   - Checkout session escrow (create, preflight, pay)
 *   - Email escrow for claimable USDC links
 *   - Pay-per-use wrapped API proxy (Exa, Firecrawl, Gemini, Grok)
 *
 * Every agent gets its own LocusClient instance with its own API key.
 *
 * @see https://docs.paywithlocus.com
 */

const BASE_URL = 'https://api.paywithlocus.com/api';
const BETA_URL = 'https://beta-api.paywithlocus.com/api';
const STATUS_PENDING_APPROVAL = 202;

/**
 * Authenticated client for a single Locus agent wallet.
 */
class LocusClient {
  /**
   * @param {string} apiKey - Locus API key for this agent
   * @param {boolean} useBeta - Whether to use the beta API endpoint
   */
  constructor(apiKey, useBeta = true) {
    this.apiKey = apiKey;
    this.baseUrl = useBeta ? BETA_URL : BASE_URL;
  }

  /**
   * Send an authenticated request to the Locus API.
   * Returns { status: 'success' | 'pending_approval', data } on success.
   * Throws on non-2xx responses (except 202 which indicates spending control hold).
   * @private
   */
  async _request(url, method = 'GET', body = null) {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();

    if (res.status === STATUS_PENDING_APPROVAL) {
      return { status: 'pending_approval', data };
    }
    if (!res.ok) {
      throw new Error(`Locus API error ${res.status}: ${JSON.stringify(data)}`);
    }
    return { status: 'success', data };
  }

  /** Get USDC balance for this agent's wallet. */
  async getBalance() {
    return this._request(`${this.baseUrl}/pay/balance`);
  }

  /**
   * Send USDC payment to another wallet address.
   * @param {string} recipientAddress - Destination wallet on Base
   * @param {number} amount - USDC amount to send
   * @param {string} memo - Human-readable payment description
   */
  async sendPayment(recipientAddress, amount, memo = '') {
    return this._request(`${this.baseUrl}/pay/send`, 'POST', {
      to_address: recipientAddress,
      amount: Number(amount),
      memo,
    });
  }

  /**
   * Send USDC via email escrow. Recipient claims funds via email link.
   * @param {string} email - Recipient email address
   * @param {number} amount - USDC amount to escrow
   * @param {string} memo - Payment description
   * @param {string|null} disburseBefore - Optional deadline for claiming
   */
  async sendEmailEscrow(email, amount, memo, disburseBefore = null) {
    const body = { email, amount: Number(amount), memo };
    if (disburseBefore) body.disburseBefore = disburseBefore;
    return this._request(`${this.baseUrl}/pay/send-email`, 'POST', body);
  }

  /** Get all USDC transactions for this agent's wallet. */
  async getTransactions() {
    return this._request(`${this.baseUrl}/pay/transactions`);
  }

  /**
   * Create a checkout session to escrow funds before work begins.
   * @param {number} amount - USDC amount to lock
   * @param {string} description - What the escrow is for
   * @param {string|undefined} webhookUrl - HTTPS webhook for status updates
   * @param {object} metadata - Arbitrary metadata (buyer, seller, task info)
   */
  async createCheckoutSession(amount, description, webhookUrl, metadata = {}) {
    const body = {
      amount: String(amount),
      description,
      metadata,
    };
    // Only include webhookUrl if it's a valid HTTPS URL (localhost causes 500)
    if (webhookUrl && webhookUrl.startsWith('https')) {
      body.webhookUrl = webhookUrl;
    }
    return this._request(`${this.baseUrl}/checkout/sessions`, 'POST', body);
  }

  /**
   * Worker agent verifies an escrow session is valid before starting work.
   * @param {string} sessionId - Checkout session ID to verify
   */
  async checkoutPreflight(sessionId) {
    return this._request(`${this.baseUrl}/checkout/agent/preflight/${sessionId}`);
  }

  /**
   * Release escrowed funds — called by buyer after work is delivered.
   * @param {string} sessionId - Checkout session ID to pay out
   */
  async checkoutPay(sessionId) {
    return this._request(`${this.baseUrl}/checkout/agent/pay/${sessionId}`, 'POST');
  }

  /**
   * Check the status of a checkout payment.
   * @param {string} txId - Transaction ID to check
   */
  async checkoutStatus(txId) {
    return this._request(`${this.baseUrl}/checkout/agent/payments/${txId}`);
  }

  /**
   * Call a wrapped API through Locus's pay-per-use proxy.
   * Each call is billed in USDC to this agent's wallet.
   * @param {string} provider - API provider (exa, firecrawl, gemini, grok)
   * @param {string} endpoint - Provider endpoint (search, chat, scrape, etc.)
   * @param {object} params - Request parameters for the provider
   */
  async callWrappedAPI(provider, endpoint, params = {}) {
    return this._request(`${this.baseUrl}/wrapped/${provider}/${endpoint}`, 'POST', params);
  }

  /** List all available wrapped API providers. */
  async listWrappedAPIs() {
    return this._request(`${this.baseUrl}/wrapped`);
  }

  /**
   * Get documentation for wrapped APIs.
   * @param {string|null} provider - Specific provider, or null for all
   */
  async getWrappedDocs(provider = null) {
    const url = provider
      ? `${this.baseUrl}/wrapped/md?provider=${provider}`
      : `${this.baseUrl}/wrapped/md`;
    return this._request(url);
  }
}

/**
 * Register a new agent wallet on the Locus beta API.
 * No auth required — returns API key and wallet address.
 * @param {string} name - Agent display name
 * @param {string|null} email - Optional email for the agent
 */
async function registerAgentWallet(name, email = null) {
  const body = { name };
  if (email) body.email = email;

  const res = await fetch(`${BETA_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  return data;
}

/**
 * Check whether an agent's smart wallet has been deployed on Base.
 * @param {string} apiKey - Agent's Locus API key
 */
async function checkWalletStatus(apiKey) {
  const res = await fetch(`${BETA_URL}/status`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return res.json();
}

module.exports = { LocusClient, registerAgentWallet, checkWalletStatus };
