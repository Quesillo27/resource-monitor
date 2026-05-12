import React, { useState } from 'react';
import { Copy } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

function defaultDownloadUrl() {
  return `${window.location.origin}/downloads`;
}

function fmtDate(value) {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

function Header({ title, meta }) {
  return <header className="page-header"><div><h1>{title}</h1></div>{meta}</header>;
}

function CommandBlock({ title, command }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    setError(false);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
        ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = command;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError(true);
      setTimeout(() => setError(false), 2500);
    }
  }
  return (
    <div className="command-box">
      <div className="command-content">
        <span className="command-title">{title}</span>
        <code>{command}</code>
      </div>
      <button
        className={`copy-btn ${copied ? 'copied' : ''} ${error ? 'failed' : ''}`}
        title="Copiar"
        aria-label="Copiar comando"
        onClick={copy}
      >
        <Copy size={16} />
        {error ? 'Error' : copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

function EnrollResult({ result, platform }) {
  const [showOther, setShowOther] = useState(false);
  const isLinux = platform === 'linux';
  const primaryTitle = isLinux ? 'Linux systemd' : 'Windows PowerShell admin';
  const primaryCmd = isLinux ? (result.linux_install_command || result.install_command) : (result.windows_install_command || result.install_command);
  const otherTitle = isLinux ? 'Windows PowerShell admin' : 'Linux systemd';
  const otherCmd = isLinux ? (result.windows_install_command || result.install_command) : (result.linux_install_command || result.install_command);
  return (
    <div className="install-result">
      <div className="install-meta">
        <strong>Token válido hasta {fmtDate(result.expires_at)}</strong>
        <span className="token-value">{result.token}</span>
      </div>
      <CommandBlock title={primaryTitle} command={primaryCmd} />
      <button type="button" className="link-btn" onClick={() => setShowOther(!showOther)}>
        {showOther ? '▲ Ocultar' : '▼ Ver comando ' + otherTitle}
      </button>
      {showOther && <CommandBlock title={otherTitle} command={otherCmd} />}
    </div>
  );
}

export default function Enrollment({ api }) {
  const [serverUrl, setServerUrl] = useState(API_BASE);
  const [downloadUrl, setDownloadUrl] = useState(() => defaultDownloadUrl());
  const [platform, setPlatform] = useState('linux');
  const [agentName, setAgentName] = useState('');
  const [profile, setProfile] = useState('balanced');
  const [interval, setIntervalValue] = useState(60);
  const [services, setServices] = useState('');
  const [ttl, setTtl] = useState(24);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function createToken(event) {
    event.preventDefault();
    setError('');
    const trimmedServer = serverUrl.trim();
    if (!trimmedServer) {
      setError('La URL del servidor API es obligatoria');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedServer)) {
      setError('La URL del servidor debe iniciar con http:// o https://');
      return;
    }
    const intervalNum = Number(interval);
    if (![15, 30, 60].includes(intervalNum)) {
      setError('El intervalo debe ser 15, 30 o 60 segundos');
      return;
    }
    setLoading(true);
    try {
      const data = await api.post('/api/enrollment-tokens', {
        name: agentName || 'Alta agente',
        ttl_hours: Number(ttl),
        server_url: trimmedServer,
        download_url: downloadUrl.trim(),
        agent_name: agentName.trim(),
        install_style: platform,
        release_version: 'latest',
        profile,
        services: services.trim(),
        interval: intervalNum,
      });
      setResult(data);
    } catch (err) {
      setError(err.message || 'No se pudo generar el token');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <Header title="Alta de agente" />
      <div className="enroll-layout">
        <div className="enroll-form-card">
          <form className="enroll-form" onSubmit={createToken}>
            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">1</span>Plataforma de destino</div>
              <div className="platform-grid">
                {[['linux', '🐧', 'Linux', 'Debian, Ubuntu, RHEL, Alpine'],['windows', '🪟', 'Windows', 'Windows 10/11, Server 2016+']].map(([val, icon, label, sub]) => (
                  <button key={val} type="button" className={`platform-card ${platform === val ? 'selected' : ''}`} onClick={() => setPlatform(val)}>
                    <span className="platform-icon">{icon}</span>
                    <strong>{label}</strong>
                    <span className="platform-sub">{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">2</span>Identidad del equipo</div>
              <div className="enroll-fields">
                <label>Nombre del equipo <span className="field-hint">opcional — se usa como hostname si se omite</span>
                  <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="ej. servidor-web-01" />
                </label>
                <div className="form-grid">
                  <label>Perfil de recolección
                    <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                      <option value="balanced">Balanceado — CPU, RAM, disco, red, procesos</option>
                      <option value="minimal">Mínimo — solo CPU, RAM y disco</option>
                      <option value="full">Full — todo + temperaturas (20 procesos)</option>
                    </select>
                  </label>
                  <label>Intervalo (segundos)
                    <select value={interval} onChange={(e) => setIntervalValue(Number(e.target.value))}>
                      <option value={15}>15 segundos</option>
                      <option value={30}>30 segundos</option>
                      <option value={60}>60 segundos (recomendado)</option>
                    </select>
                  </label>
                </div>
                <label>Servicios críticos a monitorear <span className="field-hint">separados por coma</span>
                  <input value={services} onChange={(e) => setServices(e.target.value)} placeholder="nginx, postgres, sqlservr" />
                </label>
              </div>
            </div>

            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">3</span>Conectividad</div>
              <div className="enroll-fields">
                <label>URL del servidor API <span className="field-hint">accesible desde el equipo destino</span>
                  <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://monitor.empresa.com" />
                </label>
                <label>URL de descarga del agente <span className="field-hint">puede ser URL LAN para instalaciones internas</span>
                  <input value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} placeholder="https://monitor.empresa.com/downloads" />
                </label>
                <label>Validez del token
                  <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
                    <option value="1">1 hora</option>
                    <option value="8">8 horas</option>
                    <option value="24">24 horas</option>
                    <option value="72">72 horas</option>
                  </select>
                </label>
              </div>
            </div>

            {error && <p className="form-error">{error}</p>}
            <button className="primary enroll-submit" disabled={loading}>
              {loading ? 'Generando token...' : 'Generar token e instrucciones de instalación'}
            </button>
          </form>
        </div>

        <div className="enroll-sidebar">
          <div className="enroll-info-card">
            <h3>Proceso de instalación</h3>
            <ol className="enroll-steps-list">
              <li><strong>Copia el comando</strong> generado</li>
              <li><strong>Ejecútalo</strong> en el equipo destino como administrador</li>
              <li><strong>El agente se registra</strong> automáticamente con el token</li>
              <li><strong>Aparece en el dashboard</strong> en menos de 60 segundos</li>
            </ol>
          </div>
          <div className="enroll-info-card">
            <h3>El agente recopila</h3>
            <ul className="enroll-feature-list">
              <li>CPU, RAM, swap en tiempo real</li>
              <li>Todos los discos y particiones</li>
              <li>Interfaces de red activas</li>
              <li>Top 10 procesos por consumo</li>
              <li>Estado de servicios configurados</li>
              <li>Inventario de hardware y software (24h)</li>
            </ul>
          </div>
          <div className="enroll-info-card warning-card">
            <h3>⚠️ Conectividad LAN</h3>
            <p>Si instalas en una red local, la URL del servidor debe incluir el puerto correcto. Por ejemplo: <code>http://192.168.1.10:3010</code></p>
          </div>
        </div>
      </div>

      {result && <EnrollResult result={result} platform={platform} />}
    </section>
  );
}
