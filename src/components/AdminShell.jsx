import { useEffect, useRef, useState } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import { useApp } from '../AppContext';
import { uploadBrandAsset } from '../backend/brandAssetStorage';
import '../admin.css';

const AVATAR_STORAGE_PREFIX = 'zarohr_user_avatar_v1:';

export default function AdminShell({ children, title, page }) {
  const { role, userName, logout } = useApp();

  const isHrAdmin = role === 'hr-admin';
  const displayName = userName || (role === 'super-admin' ? 'Super Admin' : 'HR Admin');
  const avatarText = (displayName.split(' ').map(w => w[0]).join('').slice(0, 2) || 'SA').toUpperCase();
  const avatarKey = `${AVATAR_STORAGE_PREFIX}${role || 'anon'}:${userName || 'default'}`;
  const fileInputRef = useRef(null);
  const [avatarUrl, setAvatarUrl] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setAvatarUrl(window.localStorage.getItem(avatarKey) || null);
    } catch (_) {
      setAvatarUrl(null);
    }
  }, [avatarKey]);

  function handleLogout() {
    logout();
    window.location.hash = '#login';
  }

  function handleAvatarClick() {
    fileInputRef.current?.click();
  }

  async function handleAvatarChange(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be under 2MB.');
      return;
    }
    try {
      const url = await uploadBrandAsset(file, {
        folder: 'avatars',
        orgKey: `${role || 'anon'}-${userName || 'default'}`,
        resize: { maxDim: 256, quality: 0.88 },
      });
      try { window.localStorage.setItem(avatarKey, url); } catch (_) { /* ignore */ }
      setAvatarUrl(url);
    } catch (err) {
      console.error('[AdminShell] avatar upload failed', err);
      alert('Could not save profile picture. Please try again.');
    }
  }

  if (isHrAdmin) {
    return <div style={{ width: '100%', minHeight: '100vh' }}>{children}</div>;
  }

  return (
    <div className="admin-app-root">
      <aside className="sidebar">
        <div className="sidebar-logo" onClick={() => { window.location.hash = '#organizations'; }}>
          <img src={zaroLogo} alt="Zaro HR" className="sidebar-brand-icon" />
          <div className="sidebar-brand-text">
            <div className="sb-brand-name">Zaro<span style={{ color: '#FFBF00' }}>HR</span></div>
            <div className="sb-brand-tag">Platform</div>
          </div>
        </div>

        <nav className="sb-nav">
          <div
            className={`sb-item${page === 'dashboard' || page === 'organizations' ? ' active' : ''}`}
            onClick={() => { window.location.hash = '#organizations'; }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            Organizations
          </div>
          <div
            className={`sb-item${page === 'comms' ? ' active' : ''}`}
            onClick={() => { window.location.hash = '#super-comms'; }}
          >
            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.2"/><path d="m3.5 7 8.5 6.2L20.5 7"/></svg>
            Communications
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-user">
            <button
              type="button"
              className={`user-avatar user-avatar-btn${avatarUrl ? ' has-image' : ''}`}
              onClick={handleAvatarClick}
              title="Change profile picture"
              style={avatarUrl ? { backgroundImage: `url(${avatarUrl})` } : undefined}
            >
              {!avatarUrl && <span className="user-avatar-initials">{avatarText}</span>}
              <span className="user-avatar-overlay" aria-hidden="true">
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/>
                  <circle cx="12" cy="13" r="3.5"/>
                </svg>
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarChange}
              style={{ display: 'none' }}
            />
            <div className="user-info">
              <div className="user-name">{displayName}</div>
              <div className="user-role">Platform Owner</div>
            </div>
            <button className="logout-btn" onClick={handleLogout} title="Sign out">
              <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>
      </aside>

      <div className="main-content">
        <div className="topbar">
          <div className="topbar-title">{title || 'Organizations'}</div>
        </div>
        <div className="page-body">
          {children}
        </div>
      </div>
    </div>
  );
}
