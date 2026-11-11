/* ============================================================
   RTNote API Client - js/api.js
   Cliente HTTP centralizado para interactuar con la API
   ============================================================ */

const PROD_API_BASE = 'https://api-rtnotebot.rtdev.uk';

class ApiClient {
  constructor() {
    this.userKey = 'rtnote_user';
    // Elimina cualquier JWT heredado: la sesión ahora vive en cookie HttpOnly.
    try { localStorage.removeItem('rtnote_token'); } catch {}
    // Limpieza de configuración anterior en desuso
    try {
      localStorage.removeItem('rtnote_api_url');
    } catch {}
  }

  /**
   * Obtiene la URL base internamente: producción por defecto,
   * con fallback silencioso a http://localhost:3000 si corre en localhost o 127.0.0.1.
   */
  getBaseUrl() {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
      if (hostname === 'localhost') return 'http://localhost:3000';
      if (hostname === '127.0.0.1') return 'http://127.0.0.1:3000';
    }
    return PROD_API_BASE;
  }

  getCurrentUser() {
    try {
      const data = localStorage.getItem(this.userKey);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  setCurrentUser(user) {
    if (user) {
      localStorage.setItem(this.userKey, JSON.stringify(user));
    } else {
      localStorage.removeItem(this.userKey);
    }
  }

  clearSession() {
    localStorage.removeItem('rtnote_token');
    localStorage.removeItem(this.userKey);
  }

  /**
   * Ejecuta peticiones HTTP contra la API con manejo de tokens y 401.
   */
  async request(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}/api${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;
    const silentUnauthorized = options.silentUnauthorized === true;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers['X-RTNote-Request'] = '1';
    }

    const config = {
      ...options,
      method,
      credentials: 'include',
      headers
    };
    delete config.silentUnauthorized;

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    let response;
    try {
      response = await fetch(url, config);
    } catch (err) {
      console.error('[API Fetch Error]', err);
      throw new Error('No se pudo conectar con el servidor. Revisa tu conexión a internet o el estado del API.');
    }

    // Manejo de sesión expirada / 401
    if (response.status === 401) {
      this.clearSession();
      if (!silentUnauthorized) {
        window.dispatchEvent(new CustomEvent('rtnote:unauthorized', { detail: { endpoint } }));
      }
      let errorMsg = 'Sesión expirada o no autorizada';
      try {
        const errorJson = await response.json();
        if (errorJson.error) errorMsg = errorJson.error;
      } catch {}
      const error = new Error(errorMsg);
      error.status = 401;
      throw error;
    }

    let data;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = { message: await response.text() };
    }

    if (!response.ok) {
      const msg = data.error || (data.details ? data.details.join(', ') : `Error HTTP ${response.status}`);
      const error = new Error(msg);
      error.status = response.status;
      error.details = data.details || null;
      throw error;
    }

    return data;
  }

  /* --- MÉTODOS DE AUTENTICACIÓN --- */

  async register(username, password, telegram_chat_id = null) {
    const body = { username, password };
    if (telegram_chat_id) body.telegram_chat_id = telegram_chat_id;
    const data = await this.request('/auth/register', { method: 'POST', body });
    if (data.user) this.setCurrentUser(data.user);
    return data;
  }

  /**
   * Crea un usuario desde una sesión autenticada sin alterar la sesión actual.
   */
  async createUser(username, password, telegram_chat_id = null) {
    const body = { username, password };
    if (telegram_chat_id) body.telegram_chat_id = telegram_chat_id;
    return await this.request('/auth/register', { method: 'POST', body });
  }

  async login(username, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: { username, password }
    });
    if (data.user) this.setCurrentUser(data.user);
    return data;
  }

  async logout() {
    return await this.request('/auth/logout', { method: 'POST' });
  }

  async getProfile({ silentUnauthorized = false } = {}) {
    const data = await this.request('/auth/profile', { method: 'GET', silentUnauthorized });
    if (data.user) this.setCurrentUser(data.user);
    return data.user;
  }

  async getTelegramStatus() {
    return await this.request('/auth/telegram/status', { method: 'GET' });
  }

  async linkTelegram(telegram_chat_id) {
    const data = await this.request('/auth/telegram', {
      method: 'PUT',
      body: { telegram_chat_id }
    });
    if (data.user) this.setCurrentUser(data.user);
    return data;
  }

  async unlinkTelegram() {
    const data = await this.request('/auth/telegram', { method: 'DELETE' });
    if (data.user) this.setCurrentUser(data.user);
    return data;
  }

  async testTelegram() {
    return await this.request('/auth/test-telegram', { method: 'POST' });
  }

  /* --- MÉTODOS DE RECORDATORIOS --- */

  async getReminders(params = {}) {
    const query = new URLSearchParams();
    if (params.view) query.append('view', params.view);
    if (params.status) query.append('status', params.status);
    if (params.limit) query.append('limit', params.limit);
    if (params.offset) query.append('offset', params.offset);

    const queryString = query.toString();
    const endpoint = `/reminders${queryString ? '?' + queryString : ''}`;
    return await this.request(endpoint, { method: 'GET' });
  }

  async getReminder(id) {
    return await this.request(`/reminders/${id}`, { method: 'GET' });
  }

  async createReminder({ title, description, scheduled_at, notify_30m_before = false, notify_15m_before = false }) {
    return await this.request('/reminders', {
      method: 'POST',
      body: { title, description, scheduled_at, notify_30m_before, notify_15m_before }
    });
  }

  async updateReminder(id, { title, description, scheduled_at, notify_30m_before, notify_15m_before }) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (description !== undefined) body.description = description;
    if (scheduled_at !== undefined) body.scheduled_at = scheduled_at;
    if (notify_30m_before !== undefined) body.notify_30m_before = notify_30m_before;
    if (notify_15m_before !== undefined) body.notify_15m_before = notify_15m_before;

    return await this.request(`/reminders/${id}`, {
      method: 'PUT',
      body
    });
  }

  async deleteReminder(id, permanent = false) {
    const query = permanent ? '?permanent=true' : '';
    return await this.request(`/reminders/${id}${query}`, {
      method: 'DELETE'
    });
  }
}

// Instancia única exportada en el ámbito global
window.api = new ApiClient();
