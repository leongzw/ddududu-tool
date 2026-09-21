import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import {
  addWallet,
  clearWallets,
  evictCaches,
  getWallets,
  parseWalletImport,
  recheckStorage,
  removeWallet,
  removeWallets,
  STORAGE_BLOCKED,
  STORAGE_LOG,
  storageUsage,
  subscribeWallets,
} from './store';
import TransferPanel from './TransferPanel';
import './Wallets.css';

const shortAddr = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

// Viewing the app inside an iframe (VS Code Simple Browser, preview panes,
// some port-forwarding UIs) blocks Web Storage BY DESIGN — detect it so the
// banner can explain why storage is blocked and how to actually fix it.
const EMBEDDED = (() => {
  try {
    return typeof window !== 'undefined' && window.self !== window.top;
  } catch {
    return true;
  }
})();

function Wallets() {
  const [wallets, setWallets] = useState(() => getWallets());
  const [importText, setImportText] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [revealed, setRevealed] = useState({});
  const [genCount, setGenCount] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [recheckMsg, setRecheckMsg] = useState('');

  useEffect(() => subscribeWallets(setWallets), []);

  // Prune selections for wallets that no longer exist.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(wallets.map((w) => w.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [wallets]);

  // Bulk import: one wallet per line — "privateKey, label" (label optional).
  // Everything lands in localStorage (unless the browser blocks storage).
  const importWallets = (e) => {
    e?.preventDefault?.();
    setError('');
    setOk('');
    const { entries, errors } = parseWalletImport(importText);
    const added = [];
    const failed = [...errors];
    for (const entry of entries) {
      try {
        addWallet(entry.key, { label: entry.label });
        added.push(entry);
      } catch (err) {
        failed.push({ line: entry.line, message: err?.message || String(err) });
      }
    }
    if (added.length) {
      setOk(
        `Imported ${added.length} wallet${added.length === 1 ? '' : 's'} → localStorage` +
          (STORAGE_BLOCKED ? ' (BLOCKED — memory only until storage is allowed!)' : ''),
      );
      setImportText('');
    }
    if (failed.length) {
      setError(
        `${failed.length} line${failed.length === 1 ? '' : 's'} rejected:\n` +
          failed.map((f) => `  line ${f.line}: ${f.message}`).join('\n'),
      );
    }
  };

  // Fresh random wallets (ethers' CSPRNG) — always saved to localStorage.
  // Still local to THIS browser: export a backup before funding them.
  const generate = () => {
    setError('');
    setOk('');
    const n = Math.max(1, Math.min(50, Number(genCount) || 1));
    const base = wallets.length;
    try {
      for (let i = 0; i < n; i++) {
        const w = ethers.Wallet.createRandom();
        addWallet(w.privateKey, {
          label: `gen-${String(base + i + 1).padStart(2, '0')}`,
          generated: true,
        });
      }
      setOk(
        `Generated ${n} wallet${n === 1 ? '' : 's'} → localStorage` +
          (STORAGE_BLOCKED
            ? ' (BLOCKED — memory only! Export a backup NOW, a reload loses them.)'
            : ' — ⚠️ these keys exist only in this browser. Export a backup before sending funds to them.'),
      );
    } catch (err) {
      // Surface it — a silent failure here looks like a dead button.
      console.error('[wallets] generate failed:', err);
      setError(err?.message || `Generation failed: ${String(err)}`);
    }
  };

  const toggleSel = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const deleteSelected = () => {
    const n = selected.size;
    if (!n) return;
    if (
      !window.confirm(
        `Delete ${n} wallet${n === 1 ? '' : 's'} from this browser?\n\nTheir PRIVATE KEYS will be lost unless you exported a backup.`,
      )
    )
      return;
    removeWallets([...selected]);
    setSelected(new Set());
    setOk(`Removed ${n} wallet${n === 1 ? '' : 's'}.`);
  };

  const removeAll = () => {
    if (
      !window.confirm(
        `Remove ALL ${wallets.length} wallets from this browser?\n\nTheir PRIVATE KEYS will be lost unless you exported a backup.`,
      )
    )
      return;
    clearWallets();
    setSelected(new Set());
    setOk('All wallets removed.');
  };

  // Re-probe real storage on demand; on success in-memory wallets are moved
  // into localStorage and the block banner clears — no reload needed.
  const recheck = () => {
    const r = recheckStorage();
    setRecheckMsg(
      r.ok
        ? '✓ Storage works again — wallets were moved into localStorage and will now persist.'
        : `✗ Still failing — browser said: ${r.error}`,
    );
  };

  // Drop regenerable app caches (funding history, collection metadata) to
  // free localStorage quota, then migrate any memory wallets into it.
  const freeSpace = () => {
    const freed = evictCaches();
    const r = recheckStorage();
    setRecheckMsg(
      r.ok
        ? `✓ Freed ${(freed / 1024).toFixed(0)} KB of caches — storage OK again, wallets moved to localStorage.`
        : `Freed ${(freed / 1024).toFixed(0)} KB but still failing — browser said: ${r.error}`,
    );
  };

  const allSelected = wallets.length > 0 && selected.size === wallets.length;

  const exportBackup = () => {
    const data = JSON.stringify(
      wallets.map((w) => ({ label: w.label, address: w.address, privateKey: w.key, storage: w.storage })),
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `ddududu-wallets-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setOk('Backup downloaded — it contains your PRIVATE KEYS in plaintext; store it somewhere safe.');
  };

  return (
    <div className="wlt">
      {STORAGE_BLOCKED && (() => {
        const quota = STORAGE_LOG.some((e) => /quota/i.test(e.error));
        const usage = storageUsage();
        const top = usage.items
          .slice(0, 3)
          .map((i) => `${i.key} · ${(i.bytes / 1024).toFixed(0)} KB`)
          .join('  |  ');
        return (
          <div className="wlt-warning storage">
            🚫{' '}
            {quota ? (
              <>
                <strong>localStorage is FULL</strong> (browser quota exceeded) — this app's own caches
                (funding-rate history, NFT collection metadata) filled the ~5 MB per-site limit, so
                wallets fall back to memory and <strong>will be lost on reload</strong>.
              </>
            ) : (
              <>
                <strong>Browser storage is blocked</strong> — wallets are held in memory only and{' '}
                <strong>will be lost when this tab reloads</strong>.
              </>
            )}
            {EMBEDDED && !quota && (
              <>
                {' '}You are viewing this page <strong>inside an embedded preview frame</strong> (VS Code
                Simple Browser / a port-forward pane blocks storage by design).{' '}
                <strong>Copy the URL (e.g. http://localhost:5173) into a real browser tab.</strong>
              </>
            )}
            {!quota && !EMBEDDED && (
              <>
                {' '}Check the padlock icon → Cookies and site data → Allow, or disable
                privacy-blocking extensions for this page.
              </>
            )}
            {quota && usage.items.length > 0 && (
              <div className="wlt-diag mono">
                usage ≈ {(usage.total / 1024 / 1024).toFixed(2)} MB · biggest: {top || '—'}
              </div>
            )}
            <div className="wlt-diag mono">
              cause: {STORAGE_LOG.length ? STORAGE_LOG.map((e) => `${e.storage}/${e.stage}: ${e.error}`).join(' | ') : 'unknown'}
            </div>
            <div className="wlt-diag-actions">
              {quota && (
                <button
                  className="wlt-btn mini"
                  type="button"
                  onClick={freeSpace}
                  title="Deletes regenerable caches (funding history, collection metadata) — never wallet keys"
                >
                  💥 Free space (clear caches)
                </button>
              )}
              <button className="wlt-btn mini" type="button" onClick={recheck}>
                Test storage again
              </button>
              {recheckMsg && <span className="wlt-diag-msg">{recheckMsg}</span>}
            </div>
          </div>
        );
      })()}
      <div className="wlt-warning">
        ⚠️ <strong>Private keys entered here live in this browser</strong> and are used to sign batch-mint
        transactions. Every wallet is <strong>saved to localStorage</strong> — <em>unencrypted</em>, on
        this machine, surviving reloads. Only use keys you control, on this machine.
      </div>

      <form className="wlt-import-form" onSubmit={importWallets}>
        <textarea
          className="wlt-input wlt-import mono"
          rows={4}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            'one wallet per line — private key, label (label optional)\n0x4c0883a69c12e…b91a, main\n0x9d4f17ba0e5c…c71e, degen-2'
          }
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') importWallets(e);
          }}
        />
        <div className="wlt-add">
          <button className="wlt-btn primary" type="submit" disabled={!importText.trim()}>
            + Import wallets
          </button>
          <span className="wlt-sep" />
          <input
            className="wlt-input count"
            type="number"
            min="1"
            max="50"
            title="How many wallets to generate"
            value={genCount}
            onChange={(e) => setGenCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          />
          <button
            className="wlt-btn"
            type="button"
            onClick={generate}
            title="Generate random wallets — saved to localStorage"
          >
            ⚡ Generate
          </button>
        </div>
      </form>

      {error && <div className="wlt-msg err">{error}</div>}
      {ok && <div className="wlt-msg ok">{ok}</div>}

      <div className="wlt-head">
        <h3>Wallets · {wallets.length}</h3>
        {wallets.length > 0 && (
          <>
            {selected.size > 0 && (
              <button className="wlt-btn danger" onClick={deleteSelected}>
                ✕ Delete selected ({selected.size})
              </button>
            )}
            <button className="wlt-btn" onClick={exportBackup} title="Download a JSON backup (contains private keys!)">
              ⬇ Export backup
            </button>
            <button
              className="wlt-btn danger"
              onClick={removeAll}
            >
              Remove all
            </button>
          </>
        )}
      </div>

      {wallets.length === 0 ? (
        <div className="wlt-empty">
          No wallets yet — paste private keys above (one per line: "key, label") or hit Generate.
          Wallets are saved to localStorage on this machine; the Opensea auto-mint page
          (NFT Mint → Opensea) and the transfer tools pick from this list.
        </div>
      ) : (
        <div className="wlt-table-wrap">
        <table className="wlt-table">
          <thead>
            <tr>
              <th className="wlt-check-col">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(wallets.map((w) => w.id)))
                  }
                  title="Select all / none"
                />
              </th>
              <th>Label</th>
              <th>Address</th>
              <th>Key</th>
              <th>Storage</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wallets.map((w) => (
              <tr key={w.id} className={selected.has(w.id) ? 'selected' : ''}>
                <td className="wlt-check-col">
                  <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggleSel(w.id)} />
                </td>
                <td className="wlt-label">
                  {w.label}
                  {w.generated && (
                    <span className="wlt-badge gen" title="Generated in this tool">
                      gen
                    </span>
                  )}
                </td>
                <td className="mono wlt-addr" title={w.address}>
                  {shortAddr(w.address)}
                </td>
                <td className="mono wlt-key">
                  {revealed[w.id] ? (
                    <span className="wlt-key-full">{w.key}</span>
                  ) : (
                    <span className="wlt-key-mask">••••••••••••{w.key.slice(-4)}</span>
                  )}
                </td>
                <td>
                  <span className={`wlt-badge ${w.storage === 'saved' ? 'saved' : 'session'}`}>
                    {w.storage === 'saved' ? 'saved' : 'session'}
                  </span>
                </td>
                <td className="wlt-row-actions">
                  <button
                    className="wlt-btn mini"
                    onClick={() => setRevealed((r) => ({ ...r, [w.id]: !r[w.id] }))}
                  >
                    {revealed[w.id] ? 'hide' : 'show'}
                  </button>
                  <button className="wlt-btn mini" onClick={() => navigator.clipboard?.writeText(w.address)}>
                    copy addr
                  </button>
                  <button
                    className="wlt-btn mini danger"
                    onClick={() => {
                      removeWallet(w.id);
                      setSelected((prev) => {
                        const next = new Set(prev);
                        next.delete(w.id);
                        return next;
                      });
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <TransferPanel wallets={wallets} />
    </div>
  );
}

export default Wallets;
