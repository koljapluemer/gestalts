import { useId, useRef, useState, type ReactNode } from 'react';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** An in-page confirmation for sandboxed views, where browser modal dialogs are unavailable. */
export function ConfirmDialog({ title, children, confirmLabel = 'Delete', onClose, onConfirm }: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const titleId = useId();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      running.current = false;
      setError(message(e));
      setBusy(false);
    }
  };
  const close = () => { if (!busy) onClose(); };
  return (
    <dialog open className="modal modal-open" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="modal-box max-w-md">
        <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
        <div className="mt-2 text-sm text-base-content/70">{children}</div>
        {error && <div role="alert" className="alert alert-error mt-4 text-sm whitespace-pre-wrap">{error}</div>}
        <div className="modal-action">
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          <button type="button" className="btn btn-error" disabled={busy} onClick={() => void confirm()}>
            {busy && <span className="loading loading-spinner loading-sm" />}{confirmLabel}
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Cancel" disabled={busy} onClick={close} />
    </dialog>
  );
}
