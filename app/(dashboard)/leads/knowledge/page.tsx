"use client";

/**
 * Business facts
 *
 * The approved facts Carla may state to customers (hours, service area,
 * booking, emergencies, sign-off). Everyone can read them; admins edit.
 */

import { useCallback, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import {
  api,
  buttonClass,
  ErrorNote,
  errorText,
  humanize,
  inputClass,
  LeadsHeader,
  primaryButtonClass,
  useMembers,
  usePolling,
} from "@/components/leads/shared";

type Entry = { id: string; key: string; title: string; body: string; active: boolean };

const SUGGESTED_KEYS = ["booking", "hours", "service_area", "emergency", "signoff"];

export default function KnowledgePage() {
  const { t } = useI18n();
  const { me, members } = useMembers();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ entries: Entry[] }>("/api/leads/knowledge");
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  usePolling(load, null);

  const isAdmin = members.some((m) => m.id === me && (m.role === "OWNER" || m.role === "ADMIN"));
  const missing = SUGGESTED_KEYS.filter((k) => !entries?.some((e) => e.key === k));

  return (
    <div className="space-y-4">
      <LeadsHeader title={t("Business facts Carla may use")} />
      <p className="max-w-2xl text-sm text-muted">
        {t("Carla only states facts listed here. If a customer asks something that is not covered, she leaves it to a person.")}
      </p>
      {!isAdmin && members.length > 0 && (
        <p className="text-sm text-muted">{t("Only admins can change these facts.")}</p>
      )}
      <ErrorNote error={error} />

      {entries === null ? (
        !error && <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <div className="space-y-3">
          {entries.length === 0 && <p className="text-sm text-muted">{t("No facts yet.")}</p>}
          {entries.map((entry) => (
            <EntryForm key={`${entry.id}-${entry.title}-${entry.body}-${entry.active}`} entry={entry} canEdit={isAdmin} onSaved={load} />
          ))}

          {isAdmin && (
            <div className="space-y-2 rounded border border-dashed border-border p-3">
              {adding !== null ? (
                <EntryForm
                  entry={{ id: "", key: adding, title: adding ? humanize(adding) : "", body: "", active: true }}
                  canEdit
                  isNew
                  onSaved={async () => {
                    setAdding(null);
                    await load();
                  }}
                  onCancel={() => setAdding(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted">{t("Add a fact:")}</span>
                  {missing.map((k) => (
                    <button key={k} type="button" onClick={() => setAdding(k)} className={buttonClass}>
                      {humanize(k)}
                    </button>
                  ))}
                  <button type="button" onClick={() => setAdding("")} className={buttonClass}>
                    {t("Other")}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EntryForm({
  entry,
  canEdit,
  isNew = false,
  onSaved,
  onCancel,
}: {
  entry: Entry;
  canEdit: boolean;
  isNew?: boolean;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const [key, setKey] = useState(entry.key);
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [active, setActive] = useState(entry.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = isNew || title !== entry.title || body !== entry.body || active !== entry.active;
  const keyValid = /^[a-z0-9_]{1,40}$/.test(key);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!keyValid || !title.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/leads/knowledge", { method: "PUT", body: { key, title: title.trim(), body: body.trim(), active } });
      await onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const idBase = `fact-${entry.id || "new"}`;

  return (
    <form onSubmit={(e) => void save(e)} className={`space-y-2 rounded border border-border p-3 ${active ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        {isNew ? (
          <>
            <label htmlFor={`${idBase}-key`} className="text-xs text-muted">
              {t("Key")}
            </label>
            <input
              id={`${idBase}-key`}
              value={key}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              placeholder="service_area"
              className={`${inputClass} w-40 font-mono`}
            />
          </>
        ) : (
          <code className="text-xs text-muted">{entry.key}</code>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={active} disabled={!canEdit} onChange={(e) => setActive(e.target.checked)} />
          {t("Carla may use this")}
        </label>
      </div>
      <label htmlFor={`${idBase}-title`} className="sr-only">
        {t("Title")}
      </label>
      <input
        id={`${idBase}-title`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        readOnly={!canEdit}
        placeholder={t("Title")}
        maxLength={200}
        className={`${inputClass} w-full font-medium`}
      />
      <label htmlFor={`${idBase}-body`} className="sr-only">
        {t("Fact")}
      </label>
      <textarea
        id={`${idBase}-body`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        readOnly={!canEdit}
        rows={3}
        maxLength={4000}
        placeholder={t("Write the fact exactly as Carla may say it.")}
        className={`${inputClass} w-full resize-y`}
      />
      {isNew && key && !keyValid && (
        <p className="text-xs text-error">{t("Use lowercase letters, numbers and underscores only.")}</p>
      )}
      {error && <p role="alert" className="text-xs text-error">{error}</p>}
      {canEdit && (
        <div className="flex gap-2">
          <button type="submit" disabled={busy || !dirty || !keyValid || !title.trim() || !body.trim()} className={primaryButtonClass}>
            {t("Save")}
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className={buttonClass}>
              {t("Cancel")}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
