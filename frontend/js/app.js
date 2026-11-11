/* ============================================================
   RTNote Main Application Logic - js/app.js
   Lógica de interfaz de usuario, PWA, Telegram y Recordatorios
   ============================================================ */

// --- Sistema Centralizado de Notificaciones Toast ---
class ToastManager {
  constructor() {
    this.container = document.getElementById('toast-container');
  }

  show(message, type = 'info', duration = 4000) {
    if (!this.container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
      <span class="toast-text">${this.escape(message)}</span>
      <button class="toast-close" aria-label="Cerrar">&times;</button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.classList.add('toast-fade-out');
      setTimeout(() => toast.remove(), 300);
    });

    this.container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.classList.add('toast-fade-out');
        setTimeout(() => toast.remove(), 300);
      }
    }, duration);
  }

  escape(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
}

window.toast = new ToastManager();

// --- Lógica Principal de la Aplicación ---
class RTNoteApp {
  constructor() {
    this.activeTab = 'upcoming'; // 'upcoming' | 'history'
    this.currentReminders = [];
    this.deferredInstallPrompt = null;
    this.init();
  }

  init() {
    this.initServiceWorker();
    this.initInstallPrompt();
    this.bindEvents();
    this.setupDefaultDateTime();

    // Si ya está autenticado al cargar la página
    if (window.auth && window.auth.isAuthenticated) {
      this.loadDashboardData();
    }
  }

  /* --- 1. Registro del Service Worker --- */
  initServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js', { scope: './' })
          .then((reg) => {
            console.log('[PWA] Service Worker registrado con éxito. Scope:', reg.scope);
            // Detectar actualizaciones
            reg.addEventListener('updatefound', () => {
              const newWorker = reg.installing;
              if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    window.toast.show('Nueva versión disponible. Recarga para actualizar.', 'info');
                  }
                });
              }
            });
          })
          .catch((err) => {
            console.warn('[PWA] Error al registrar Service Worker:', err);
          });
      });
    }
  }

  /* --- 2. Instalación PWA (beforeinstallprompt) --- */
  initInstallPrompt() {
    const installBtn = document.getElementById('btn-install-pwa');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      if (installBtn) installBtn.classList.remove('hidden');
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!this.deferredInstallPrompt) return;
        this.deferredInstallPrompt.prompt();
        const { outcome } = await this.deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') {
          window.toast.show('¡Gracias por instalar RT Note!', 'success');
        }
        this.deferredInstallPrompt = null;
        installBtn.classList.add('hidden');
      });
    }

    window.addEventListener('appinstalled', () => {
      this.deferredInstallPrompt = null;
      if (installBtn) installBtn.classList.add('hidden');
      console.log('[PWA] Aplicación instalada correctamente.');
    });
  }

  /* --- 3. Enlace de Eventos del DOM --- */
  bindEvents() {
    // Escuchar login exitoso o logout
    window.addEventListener('rtnote:login_success', () => this.loadDashboardData());
    window.addEventListener('rtnote:logout', () => {
      this.currentReminders = [];
      this.renderReminders();
    });

    // Submit Login
    const formLogin = document.getElementById('form-login');
    if (formLogin) {
      formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = formLogin.username.value.trim();
        const password = formLogin.password.value;
        const btn = formLogin.querySelector('button[type="submit"]');
        this.setButtonLoading(btn, true);

        try {
          await window.auth.login(username, password);
          formLogin.reset();
        } catch (err) {
          // Toast manejado por auth.js
        } finally {
          this.setButtonLoading(btn, false);
        }
      });
    }

    // Registro público: la cuenta queda pendiente de aprobación.
    const btnShowRegister = document.getElementById('btn-show-register');
    const btnCancelRegister = document.getElementById('btn-cancel-register');
    const formPublicRegister = document.getElementById('form-public-register');
    if (btnShowRegister && formPublicRegister && formLogin) {
      btnShowRegister.addEventListener('click', () => {
        formLogin.classList.add('hidden');
        document.querySelector('.auth-register-prompt')?.classList.add('hidden');
        formPublicRegister.classList.remove('hidden');
      });
      btnCancelRegister?.addEventListener('click', () => {
        formPublicRegister.classList.add('hidden');
        formLogin.classList.remove('hidden');
        document.querySelector('.auth-register-prompt')?.classList.remove('hidden');
        formPublicRegister.reset();
      });
      formPublicRegister.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = formPublicRegister.querySelector('button[type="submit"]');
        this.setButtonLoading(btn, true);
        try {
          await window.auth.register(formPublicRegister.username.value.trim(), formPublicRegister.password.value);
          formPublicRegister.reset();
          formPublicRegister.classList.add('hidden');
          formLogin.classList.remove('hidden');
          document.querySelector('.auth-register-prompt')?.classList.remove('hidden');
        } catch (err) {
          // El módulo de autenticación presenta el error.
        } finally {
          this.setButtonLoading(btn, false);
        }
      });
    }

    // Submit Crear Nuevo Usuario (en Modal de Configuración)
    const formCreateUser = document.getElementById('form-create-user');
    if (formCreateUser) {
      formCreateUser.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleCreateUser(formCreateUser);
      });
    }

    // Botón de Cerrar Sesión
    const btnLogout = document.getElementById('btn-logout');
    if (btnLogout) {
      btnLogout.addEventListener('click', () => window.auth.logout());
    }

    // Pestañas de Recordatorios (Próximos / Historial)
    const tabUpcoming = document.getElementById('tab-reminders-upcoming');
    const tabHistory = document.getElementById('tab-reminders-history');

    if (tabUpcoming && tabHistory) {
      tabUpcoming.addEventListener('click', () => {
        this.activeTab = 'upcoming';
        tabUpcoming.classList.add('active');
        tabHistory.classList.remove('active');
        this.loadReminders();
      });

      tabHistory.addEventListener('click', () => {
        this.activeTab = 'history';
        tabHistory.classList.add('active');
        tabUpcoming.classList.remove('active');
        this.loadReminders();
      });
    }

    // Formulario Crear Recordatorio
    const formReminder = document.getElementById('form-create-reminder');
    if (formReminder) {
      formReminder.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleCreateReminder(formReminder);
      });
    }

    // Telegram: Vincular Chat ID
    const formTelegram = document.getElementById('form-link-telegram');
    if (formTelegram) {
      formTelegram.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleLinkTelegram(formTelegram);
      });
    }

    // Telegram: Probar Conexión
    const btnTestTelegram = document.getElementById('btn-test-telegram');
    if (btnTestTelegram) {
      btnTestTelegram.addEventListener('click', async () => {
        await this.handleTestTelegram(btnTestTelegram);
      });
    }

    // Telegram: Desvincular
    const btnUnlinkTelegram = document.getElementById('btn-unlink-telegram');
    if (btnUnlinkTelegram) {
      btnUnlinkTelegram.addEventListener('click', async () => {
        await this.handleUnlinkTelegram();
      });
    }

    // Guía Paso a Paso de Telegram (Modal)
    const btnOpenTgGuide = document.getElementById('btn-open-tg-guide');
    const modalTgGuide = document.getElementById('modal-tg-guide');
    const btnCloseTgGuide = document.getElementById('btn-close-tg-guide');

    if (btnOpenTgGuide && modalTgGuide) {
      btnOpenTgGuide.addEventListener('click', () => modalTgGuide.classList.remove('hidden'));
    }
    if (btnCloseTgGuide && modalTgGuide) {
      btnCloseTgGuide.addEventListener('click', () => modalTgGuide.classList.add('hidden'));
    }

    // Modal de Edición de Recordatorio
    const modalEdit = document.getElementById('modal-edit-reminder');
    const formEdit = document.getElementById('form-edit-reminder');
    const btnCloseEdit = document.getElementById('btn-close-edit-modal');

    if (btnCloseEdit && modalEdit) {
      btnCloseEdit.addEventListener('click', () => modalEdit.classList.add('hidden'));
    }

    if (formEdit) {
      formEdit.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleUpdateReminder(formEdit);
      });
    }

    // Modal de Confirmación de Eliminación
    const modalDelete = document.getElementById('modal-delete-reminder');
    const btnCloseDelete = document.getElementById('btn-close-delete-modal');
    if (btnCloseDelete && modalDelete) {
      btnCloseDelete.addEventListener('click', () => modalDelete.classList.add('hidden'));
    }

    // Configuración Unificada (Modal Settings)
    const btnOpenSettings = document.getElementById('btn-open-settings');
    const modalSettings = document.getElementById('modal-settings');
    const btnCloseSettings = document.getElementById('btn-close-settings');
    const btnBannerSettings = document.getElementById('btn-banner-open-settings');

    if (btnOpenSettings && modalSettings) {
      btnOpenSettings.addEventListener('click', () => {
        modalSettings.classList.remove('hidden');
        this.loadTelegramCard();
        this.loadAdminRequests();
        this.loadAdminUsers();
      });
    }
    if (btnBannerSettings && modalSettings) {
      btnBannerSettings.addEventListener('click', () => {
        modalSettings.classList.remove('hidden');
        this.loadTelegramCard();
        this.loadAdminRequests();
        this.loadAdminUsers();
      });
    }
    if (btnCloseSettings && modalSettings) {
      btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));
    }

    const resetPasswordModal = document.getElementById('modal-reset-password');
    const closeResetPasswordModal = () => {
      resetPasswordModal?.classList.add('hidden');
      document.getElementById('form-reset-password')?.reset();
      this.resetPasswordUserId = null;
    };
    document.getElementById('btn-close-reset-password')?.addEventListener('click', closeResetPasswordModal);
    document.getElementById('btn-cancel-reset-password')?.addEventListener('click', closeResetPasswordModal);
    document.getElementById('form-reset-password')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = document.getElementById('reset-password-input').value;
      const confirmation = document.getElementById('reset-password-confirm').value;
      if (password.length < 8 || password.length > 72) {
        window.toast.show('La contraseña debe tener entre 8 y 72 caracteres.', 'warning');
        return;
      }
      if (password !== confirmation) {
        window.toast.show('Las contraseñas no coinciden.', 'warning');
        document.getElementById('reset-password-confirm').focus();
        return;
      }
      const submit = event.currentTarget.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await window.api.resetAdminUserPassword(this.resetPasswordUserId, password);
        closeResetPasswordModal();
        window.toast.show('Contraseña actualizada.', 'success');
      } catch (err) {
        window.toast.show(err.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });

    document.getElementById('btn-refresh-admin-users')?.addEventListener('click', () => this.loadAdminUsers());
    document.getElementById('admin-users-search')?.addEventListener('input', () => this.filterAdminUsers());
    document.getElementById('admin-users-list')?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-user-action]'); if (!button) return;
      const id = button.dataset.userId;
      try {
        if (button.dataset.userAction === 'toggle') {
          await window.api.updateAdminUser(id, { is_active: button.dataset.active !== 'true' });
          window.toast.show('Estado de cuenta actualizado.', 'success'); await this.loadAdminUsers();
        } else if (button.dataset.userAction === 'password') {
          this.openResetPasswordModal(id, button.closest('.admin-user-item')?.querySelector('strong')?.textContent || 'usuario');
        } else if (button.dataset.userAction === 'role') {
          const role = button.dataset.role === 'admin' ? 'user' : 'admin'; if (!window.confirm(`¿Cambiar el rol a ${role}?`)) return;
          await window.api.updateAdminUser(id, { role }); await this.loadAdminUsers(); window.toast.show('Rol actualizado.', 'success');
        }
      } catch (err) { window.toast.show(err.message, 'error'); }
    });

    const btnRefreshAdmin = document.getElementById('btn-refresh-admin-requests');
    btnRefreshAdmin?.addEventListener('click', () => this.loadAdminRequests());
    const adminRequestsList = document.getElementById('admin-requests-list');
    adminRequestsList?.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-approval-action]');
      if (!button) return;
      const userId = button.dataset.userId;
      const approval = button.dataset.approvalAction;
      button.disabled = true;
      try {
        await window.api.setUserApproval(userId, approval);
        window.toast.show(approval === 'approved' ? 'Solicitud aprobada.' : 'Solicitud rechazada.', 'success');
        await Promise.all([this.loadAdminRequests(), this.loadAdminUsers()]);
      } catch (err) {
        window.toast.show(err.message, 'error');
        button.disabled = false;
      }
    });

    // Botón para refrescar recordatorios
    const btnRefresh = document.getElementById('btn-refresh-reminders');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.loadReminders());
    }
  }

  /* --- 4. Inicializar Fecha y Hora Local (Honduras UTC-6) --- */
  setupDefaultDateTime() {
    const input = document.getElementById('reminder-datetime');
    if (!input) return;

    // Calcular hora local actual + 15 minutos
    const now = new Date();
    const future = new Date(now.getTime() + 15 * 60 * 1000);

    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = future.getFullYear();
    const mm = pad(future.getMonth() + 1);
    const dd = pad(future.getDate());
    const hh = pad(future.getHours());
    const min = pad(future.getMinutes());

    const formatted = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
    input.value = formatted;
    input.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  /* --- 5. Cargar Datos del Dashboard --- */
  async loadDashboardData() {
    await Promise.all([this.loadTelegramCard(), this.loadReminders()]);
  }

  /* --- 6. Tarjeta y Estado de Telegram & Usuarios --- */
  async loadTelegramCard() {
    const warningBanner = document.getElementById('telegram-warning-banner');
    const formLink = document.getElementById('form-link-telegram');
    const activeInfo = document.getElementById('telegram-linked-info');
    const chatIdBadge = document.getElementById('telegram-chat-id-display');
    const botUserDisplay = document.getElementById('telegram-bot-user-display');

    try {
      const status = await window.api.getTelegramStatus();

      if (botUserDisplay) {
        botUserDisplay.textContent = status.bot_username ? `@${status.bot_username}` : '@rtnotebot';
      }

      if (status.linked) {
        if (warningBanner) warningBanner.classList.add('hidden');
        if (formLink) formLink.classList.add('hidden');
        if (activeInfo) activeInfo.classList.remove('hidden');
        if (chatIdBadge) chatIdBadge.textContent = status.telegram_chat_id;
      } else {
        if (warningBanner) warningBanner.classList.remove('hidden');
        if (formLink) formLink.classList.remove('hidden');
        if (activeInfo) activeInfo.classList.add('hidden');
      }
    } catch (err) {
      console.warn('[Telegram Status Error]', err);
    }
  }

  async loadAdminUsers() {
    const section = document.getElementById('admin-users-section'); const list = document.getElementById('admin-users-list');
    if (!section || !list) return;
    if (window.auth?.user?.role !== 'admin') { section.classList.add('hidden'); return; }
    section.classList.remove('hidden'); list.textContent = 'Cargando usuarios...';
    try {
      const data = await window.api.getAdminUsers('');
      list.innerHTML = data.users.map((u) => `<div class="admin-user-item" data-search="${window.toast.escape(u.username.toLowerCase())}" style="padding:.75rem 0;border-bottom:1px solid var(--border-color)"><div style="display:flex;justify-content:space-between;gap:.75rem;align-items:center;flex-wrap:wrap"><div><strong>${window.toast.escape(u.username)}</strong><div class="settings-desc">${u.role} · ${u.approval_status} · ${u.is_active ? 'Activo' : 'Desactivado'} · ${u.telegram_linked ? 'Telegram vinculado' : 'Sin Telegram'}</div></div><div style="display:flex;gap:.4rem;flex-wrap:wrap"><button class="btn btn-sm btn-secondary" data-user-action="password" data-user-id="${u.id}">Contraseña</button><button class="btn btn-sm btn-secondary" data-user-action="role" data-role="${u.role}" data-user-id="${u.id}">Cambiar rol</button><button class="btn btn-sm btn-ghost" data-user-action="toggle" data-active="${u.is_active}" data-user-id="${u.id}">${u.is_active ? 'Desactivar' : 'Activar'}</button></div></div></div>`).join('') || 'No hay usuarios registrados.';
    } catch (err) { list.textContent = err.message; }
  }

  openResetPasswordModal(userId, username) {
    this.resetPasswordUserId = userId;
    document.getElementById('reset-password-username').textContent = username;
    document.getElementById('form-reset-password')?.reset();
    document.getElementById('modal-reset-password')?.classList.remove('hidden');
    document.getElementById('reset-password-input')?.focus();
  }

  filterAdminUsers() {
    const q = (document.getElementById('admin-users-search')?.value || '').trim().toLowerCase();
    document.querySelectorAll('#admin-users-list .admin-user-item').forEach((el) => el.classList.toggle('hidden', !el.dataset.search.includes(q)));
  }

  async loadAdminRequests() {
    const section = document.getElementById('admin-requests-section');
    const list = document.getElementById('admin-requests-list');
    if (!section || !list) return;
    const user = window.auth?.user;
    if (user?.role !== 'admin') {
      section.classList.add('hidden');
      return;
    }
    section.classList.remove('hidden');
    list.textContent = 'Cargando solicitudes...';
    try {
      const data = await window.api.getAdminUsers('pending');
      if (!data.users.length) {
        list.textContent = 'No hay solicitudes pendientes.';
        return;
      }
      list.innerHTML = data.users.map((item) => `
        <div class="admin-request-item" style="display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.75rem 0;border-bottom:1px solid var(--border-color);">
          <div><strong>${window.toast.escape(item.username)}</strong><div class="settings-desc">Solicitud ${new Date(item.created_at).toLocaleDateString('es-HN')}</div></div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-sm btn-primary" data-approval-action="approved" data-user-id="${item.id}">Aprobar</button>
            <button type="button" class="btn btn-sm btn-secondary" data-approval-action="rejected" data-user-id="${item.id}">Rechazar</button>
          </div>
        </div>`).join('');
    } catch (err) {
      list.textContent = err.message;
    }
  }

  async handleCreateUser(form) {
    const username = form.username.value.trim();
    const password = form.password.value;
    const chatId = form.telegram_chat_id ? form.telegram_chat_id.value.trim() : null;

    if (!username || !password) {
      window.toast.show('Usuario y contraseña son requeridos.', 'warning');
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    this.setButtonLoading(btn, true);

    try {
      const res = await window.api.createUser(username, password, chatId || null);
      window.toast.show(`Usuario "${res.user.username}" creado y aprobado.`, 'success');
      form.reset();
    } catch (err) {
      window.toast.show(err.message, 'error');
    } finally {
      this.setButtonLoading(btn, false);
    }
  }

  async handleLinkTelegram(form) {
    const chatId = form.telegram_chat_id.value.trim();
    if (!chatId) return;

    const btn = form.querySelector('button[type="submit"]');
    this.setButtonLoading(btn, true);

    try {
      const res = await window.api.linkTelegram(chatId);
      window.toast.show('¡Chat de Telegram vinculado correctamente!', 'success');
      form.reset();
      await this.loadTelegramCard();
    } catch (err) {
      window.toast.show(err.message, 'error');
    } finally {
      this.setButtonLoading(btn, false);
    }
  }

  async handleUnlinkTelegram() {
    if (!confirm('¿Deseas desvincular tu Telegram? Ya no recibirás notificaciones.')) return;

    try {
      await window.api.unlinkTelegram();
      window.toast.show('Telegram desvinculado.', 'info');
      await this.loadTelegramCard();
    } catch (err) {
      window.toast.show(err.message, 'error');
    }
  }

  async handleTestTelegram(btn) {
    this.setButtonLoading(btn, true);
    try {
      await window.api.testTelegram();
      window.toast.show('¡Mensaje enviado a tu Telegram! Revisa @rtnotebot.', 'success');
    } catch (err) {
      window.toast.show(err.message, 'error');
    } finally {
      this.setButtonLoading(btn, false);
    }
  }

  /* --- 7. Gestión de Recordatorios (CRUD) --- */
  async loadReminders() {
    const listContainer = document.getElementById('reminders-list');
    const countBadge = document.getElementById('upcoming-count-badge');
    if (!listContainer) return;

    listContainer.innerHTML = '<div class="state-loading"><div class="spinner"></div><p>Cargando recordatorios...</p></div>';

    try {
      const res = await window.api.getReminders({ view: this.activeTab });
      this.currentReminders = res.reminders || [];

      // Actualizar contador de pendientes
      if (countBadge && res.counts) {
        countBadge.textContent = res.counts.pending || '0';
      }

      this.renderReminders();
    } catch (err) {
      listContainer.innerHTML = `
        <div class="state-error">
          <p>⚠️ No se pudieron cargar los recordatorios.</p>
          <small>${this.escape(err.message)}</small>
        </div>
      `;
    }
  }

  renderReminders() {
    const listContainer = document.getElementById('reminders-list');
    if (!listContainer) return;

    if (!this.currentReminders.length) {
      const isUpcoming = this.activeTab === 'upcoming';
      listContainer.innerHTML = `
        <div class="state-empty">
          <div class="empty-icon">${isUpcoming ? '🔔' : '📜'}</div>
          <h3>${isUpcoming ? 'No tienes recordatorios próximos' : 'Historial vacío'}</h3>
          <p>${isUpcoming ? 'Crea uno usando el formulario superior.' : 'Los recordatorios enviados o cancelados aparecerán aquí.'}</p>
        </div>
      `;
      return;
    }

    listContainer.innerHTML = this.currentReminders
      .map((r) => this.renderReminderCard(r))
      .join('');

    // Adjuntar escuchadores a botones de acción
    listContainer.querySelectorAll('.btn-edit-reminder').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const reminder = this.currentReminders.find((item) => item.id === id);
        if (reminder) this.openEditModal(reminder);
      });
    });

    listContainer.querySelectorAll('.btn-delete-reminder').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const reminder = this.currentReminders.find((item) => item.id === id);
        if (reminder) this.openDeleteModal(reminder);
      });
    });
  }

  renderReminderCard(r) {
    let statusClass = 'status-pending';
    let statusLabel = 'Pendiente';

    if (r.status === 'sent') {
      statusClass = 'status-sent';
      statusLabel = 'Enviado';
    } else if (r.status === 'failed') {
      statusClass = 'status-failed';
      statusLabel = 'Fallido';
    } else if (r.status === 'cancelled') {
      statusClass = 'status-cancelled';
      statusLabel = 'Cancelado';
    }

    const isPending = r.status === 'pending';

    let preBadges = '';
    if (r.notify_30m_before) {
      const sent = r.sent_30m_at ? ' ✓' : '';
      preBadges += `<span class="badge badge-pre-notify" title="${r.sent_30m_at ? 'Pre-aviso 30m enviado' : 'Pre-aviso 30m pendiente'}">⏱️ -30m${sent}</span>`;
    }
    if (r.notify_15m_before) {
      const sent = r.sent_15m_at ? ' ✓' : '';
      preBadges += `<span class="badge badge-pre-notify" title="${r.sent_15m_at ? 'Pre-aviso 15m enviado' : 'Pre-aviso 15m pendiente'}">⏱️ -15m${sent}</span>`;
    }

    return `
      <article class="reminder-card ${statusClass}" data-id="${r.id}">
        <div class="reminder-card-header">
          <div class="badges-wrapper">
            <span class="badge ${statusClass}">${statusLabel}</span>
            ${preBadges}
          </div>
          <span class="reminder-date">📅 ${r.scheduled_at_display || r.scheduled_at}</span>
        </div>

        <h4 class="reminder-title">${this.escape(r.title)}</h4>

        ${r.description ? `<p class="reminder-desc">${this.escape(r.description)}</p>` : ''}

        ${
          r.status === 'failed' && r.last_error
            ? `<div class="reminder-error">⚠️ Motivo: ${this.escape(r.last_error)}</div>`
            : ''
        }

        ${
          r.sent_at_display
            ? `<div class="reminder-meta">Enviado: ${r.sent_at_display}</div>`
            : ''
        }

        <div class="reminder-actions">
          ${
            isPending
              ? `
              <button class="btn btn-sm btn-secondary btn-edit-reminder" data-id="${r.id}" title="Editar">
                ✏️ Editar
              </button>
              <button class="btn btn-sm btn-danger btn-delete-reminder" data-id="${r.id}" title="Cancelar o eliminar">
                🗑️ Cancelar
              </button>
            `
              : `
              <button class="btn btn-sm btn-ghost btn-delete-reminder" data-id="${r.id}" title="Eliminar definitivamente">
                🗑️ Eliminar
              </button>
            `
          }
        </div>
      </article>
    `;
  }

  async handleCreateReminder(form) {
    const title = form.title.value.trim();
    const description = form.description.value.trim();
    const scheduled_at = form.scheduled_at.value;
    const notify_30m_before = form.notify_30m_before ? form.notify_30m_before.checked : false;
    const notify_15m_before = form.notify_15m_before ? form.notify_15m_before.checked : false;

    if (!title || !scheduled_at) {
      window.toast.show('El título y la fecha son obligatorios.', 'warning');
      return;
    }

    const btn = form.querySelector('button[type="submit"]');
    this.setButtonLoading(btn, true);

    try {
      await window.api.createReminder({
        title,
        description: description || null,
        scheduled_at,
        notify_30m_before,
        notify_15m_before,
      });
      window.toast.show('¡Recordatorio programado con éxito!', 'success');
      form.reset();
      this.setupDefaultDateTime();
      if (this.activeTab !== 'upcoming') {
        document.getElementById('tab-reminders-upcoming').click();
      } else {
        await this.loadReminders();
      }
    } catch (err) {
      window.toast.show(err.message, 'error');
    } finally {
      this.setButtonLoading(btn, false);
    }
  }

  openEditModal(reminder) {
    const modal = document.getElementById('modal-edit-reminder');
    const form = document.getElementById('form-edit-reminder');
    if (!modal || !form) return;

    form.dataset.id = reminder.id;
    form.edit_title.value = reminder.title;
    form.edit_description.value = reminder.description || '';

    if (form.edit_notify_30m_before) {
      form.edit_notify_30m_before.checked = Boolean(reminder.notify_30m_before);
    }
    if (form.edit_notify_15m_before) {
      form.edit_notify_15m_before.checked = Boolean(reminder.notify_15m_before);
    }

    // Convertir a formato datetime-local si está disponible en scheduled_at_local
    if (reminder.scheduled_at_local) {
      // Formato: 2026-10-15T08:30:00-06:00 -> slice(0, 16)
      form.edit_scheduled_at.value = reminder.scheduled_at_local.slice(0, 16);
    } else {
      const d = new Date(reminder.scheduled_at);
      const pad = (n) => String(n).padStart(2, '0');
      form.edit_scheduled_at.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    modal.classList.remove('hidden');
  }

  async handleUpdateReminder(form) {
    const id = Number(form.dataset.id);
    const title = form.edit_title.value.trim();
    const description = form.edit_description.value.trim();
    const scheduled_at = form.edit_scheduled_at.value;
    const notify_30m_before = form.edit_notify_30m_before ? form.edit_notify_30m_before.checked : false;
    const notify_15m_before = form.edit_notify_15m_before ? form.edit_notify_15m_before.checked : false;

    const btn = form.querySelector('button[type="submit"]');
    this.setButtonLoading(btn, true);

    try {
      await window.api.updateReminder(id, {
        title,
        description: description || null,
        scheduled_at,
        notify_30m_before,
        notify_15m_before,
      });
      window.toast.show('Recordatorio actualizado.', 'success');
      document.getElementById('modal-edit-reminder').classList.add('hidden');
      await this.loadReminders();
    } catch (err) {
      window.toast.show(err.message, 'error');
    } finally {
      this.setButtonLoading(btn, false);
    }
  }

  openDeleteModal(reminder) {
    const modal = document.getElementById('modal-delete-reminder');
    const titleEl = document.getElementById('delete-modal-title');
    const btnCancel = document.getElementById('btn-confirm-cancel');
    const btnPermanent = document.getElementById('btn-confirm-permanent');

    if (!modal) return;
    if (titleEl) titleEl.textContent = `"${reminder.title}"`;

    // Si ya no está pendiente, deshabilitar opción de cancelar y solo permitir eliminación física
    const isPending = reminder.status === 'pending';
    if (btnCancel) {
      btnCancel.style.display = isPending ? 'inline-flex' : 'none';
      btnCancel.onclick = async () => {
        try {
          await window.api.deleteReminder(reminder.id, false);
          window.toast.show('Recordatorio cancelado.', 'info');
          modal.classList.add('hidden');
          await this.loadReminders();
        } catch (err) {
          window.toast.show(err.message, 'error');
        }
      };
    }

    if (btnPermanent) {
      btnPermanent.onclick = async () => {
        try {
          await window.api.deleteReminder(reminder.id, true);
          window.toast.show('Recordatorio eliminado definitivamente.', 'info');
          modal.classList.add('hidden');
          await this.loadReminders();
        } catch (err) {
          window.toast.show(err.message, 'error');
        }
      };
    }

    modal.classList.remove('hidden');
  }

  /* --- Helpers de Interfaz --- */
  setButtonLoading(btn, isLoading) {
    if (!btn) return;
    if (isLoading) {
      btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-small"></span> Cargando...';
      btn.disabled = true;
    } else {
      btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
      btn.disabled = false;
    }
  }

  escape(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }
}

// Inicializar al cargar el DOM
document.addEventListener('DOMContentLoaded', () => {
  window.app = new RTNoteApp();
});
