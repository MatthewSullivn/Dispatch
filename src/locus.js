const BASE_URL = 'https://api.paywithlocus.com/api';
const BETA_URL = 'https://beta-api.paywithlocus.com/api';

class LocusClient {
  constructor(apiKey, useBeta = true) {
    this.apiKey = apiKey;
    this.baseUrl = useBeta ? BETA_URL : BASE_URL;
    this.betaUrl = BETA_URL;
  }

  async _request(url, method = 'GET', body = null) {
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(url, options);
    const data = await res.json();

    if (res.status === 202) {
      return { status: 'pending_approval', data };
    }
    if (!res.ok) {
      throw new Error(`Locus API error ${res.status}: ${JSON.stringify(data)}`);
    }
    return { status: 'success', data };
  }

  async getBalance() {
    return this._request(`${this.baseUrl}/pay/balance`);
  }

  async sendPayment(recipientAddress, amount, memo = '') {
    return this._request(`${this.baseUrl}/pay/send`, 'POST', {
      to_address: recipientAddress,
      amount: Number(amount),
      memo,
    });
  }

  async sendEmailEscrow(email, amount, description, disburseBefore = null) {
    const body = { email, amount: String(amount), description };
    if (disburseBefore) body.disburseBefore = disburseBefore;
    return this._request(`${this.baseUrl}/pay/send-email`, 'POST', body);
  }

  async getTransactions() {
    return this._request(`${this.baseUrl}/pay/transactions`);
  }

  async createCheckoutSession(amount, description, webhookUrl, metadata = {}) {
    return this._request(`${this.baseUrl}/checkout/sessions`, 'POST', {
      amount: String(amount),
      description,
      webhookUrl,
      metadata,
    });
  }

  async checkoutPreflight(sessionId) {
    return this._request(`${this.baseUrl}/checkout/agent/preflight/${sessionId}`);
  }

  async checkoutPay(sessionId) {
    return this._request(`${this.baseUrl}/checkout/agent/pay/${sessionId}`, 'POST');
  }

  async checkoutStatus(txId) {
    return this._request(`${this.baseUrl}/checkout/agent/payments/${txId}`);
  }

  async callWrappedAPI(provider, endpoint, params = {}) {
    return this._request(`${this.baseUrl}/wrapped/${provider}/${endpoint}`, 'POST', params);
  }

  async listWrappedAPIs() {
    return this._request(`${this.baseUrl}/wrapped`);
  }

  async getWrappedDocs(provider = null) {
    const url = provider
      ? `${this.baseUrl}/wrapped/md?provider=${provider}`
      : `${this.baseUrl}/wrapped/md`;
    return this._request(url);
  }
}

// Register a new agent wallet (beta API, no auth needed)
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

// Check wallet deployment status
async function checkWalletStatus(apiKey) {
  const res = await fetch(`${BETA_URL}/status`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return res.json();
}

module.exports = { LocusClient, registerAgentWallet, checkWalletStatus };
