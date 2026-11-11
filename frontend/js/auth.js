/* ============================================================
   RTNote Auth Module - js/auth.js
   Gestión de sesiones, login, registro y protección de vistas
   ============================================================ */

class AuthManager {
  constructor() {
    this.isAuthenticated = false;
    this.user = null;
    this.init();
  }

  init() {
    // Escuchar evento de token expirado o 401 lanzado por api.js
    window.addEventListener('rtnote:unauthorized', () => {
      this.handleUnauthorized();
    });

    // Validar sesión existente al cargar
    this.checkSession();
  }

  checkSession() {
    const token = window.api.getToken();
    const storedUser = window.api.getCurrentUser();

    if (token && storedUser) {
      this.isAuthenticated = true;
      this.user = storedUser;
      this.showAppView();
      // Refrescar perfil en segundo plano para verificar validez
      window.api.getProfile().then((freshUser) => {
        this.user = freshUser;
        this.updateUserBadge();
      }).catch((err) => {
        console.warn('[Auth] No se pudo refrescar perfil:', err.message);
      });
    } else {
      this.isAuthenticated = false;
      this.user = null;
      this.showAuthView();
    }
  }

  handleUnauthorized() {
    this.isAuthenticated = false;
    this.user = null;
    this.showAuthView();
    if (window.toast) {
      window.toast.show('Tu sesión ha expirado. Por favor, ingresa de nuevo.', 'warning');
    }
  }

  async login(username, password) {
    try {
      const data = await window.api.login(username, password);
      this.isAuthenticated = true;
      this.user = data.user;
      this.showAppView();
      if (window.toast) {
        window.toast.show(`¡Bienvenido de nuevo, ${this.user.username}!`, 'success');
      }
      // Notificar a la app principal para cargar recordatorios y telegram status
      window.dispatchEvent(new CustomEvent('rtnote:login_success', { detail: { user: this.user } }));
      return data;
    } catch (err) {
      if (window.toast) window.toast.show(err.message, 'error');
      throw err;
    }
  }

  async register(username, password, telegram_chat_id = null) {
    try {
      const data = await window.api.register(username, password, telegram_chat_id);
      this.isAuthenticated = true;
      this.user = data.user;
      this.showAppView();
      if (window.toast) {
        window.toast.show(`¡Cuenta creada exitosamente! Bienvenido, ${this.user.username}.`, 'success');
      }
      window.dispatchEvent(new CustomEvent('rtnote:login_success', { detail: { user: this.user } }));
      return data;
    } catch (err) {
      if (window.toast) window.toast.show(err.message, 'error');
      throw err;
    }
  }

  logout() {
    window.api.clearSession();
    this.isAuthenticated = false;
    this.user = null;
    this.showAuthView();
    if (window.toast) {
      window.toast.show('Has cerrado sesión correctamente.', 'info');
    }
    window.dispatchEvent(new CustomEvent('rtnote:logout'));
  }

  showAuthView() {
    const authSection = document.getElementById('auth-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const headerUser = document.getElementById('header-user-badge');
    const btnSettings = document.getElementById('btn-open-settings');

    if (authSection) authSection.classList.remove('hidden');
    if (dashboardSection) dashboardSection.classList.add('hidden');
    if (headerUser) headerUser.classList.add('hidden');
    if (btnSettings) btnSettings.classList.add('hidden');
  }

  showAppView() {
    const authSection = document.getElementById('auth-section');
    const dashboardSection = document.getElementById('dashboard-section');
    const headerUser = document.getElementById('header-user-badge');
    const btnSettings = document.getElementById('btn-open-settings');

    if (authSection) authSection.classList.add('hidden');
    if (dashboardSection) dashboardSection.classList.remove('hidden');
    if (headerUser) {
      headerUser.classList.remove('hidden');
      this.updateUserBadge();
    }
    if (btnSettings) btnSettings.classList.remove('hidden');
  }

  updateUserBadge() {
    const usernameEl = document.getElementById('nav-username');
    if (usernameEl && this.user) {
      usernameEl.textContent = this.user.username;
    }
  }
}

window.auth = new AuthManager();
