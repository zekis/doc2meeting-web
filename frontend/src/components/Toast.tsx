import { useEffect, useState, useCallback, useRef } from "react";
import Icon from "@mdi/react";
import {
  mdiClose,
  mdiAlertCircleOutline,
  mdiCheckCircleOutline,
} from "@mdi/js";

export interface ToastMessage {
  id: string;
  type: "error" | "success";
  text: string;
}

interface ToastContainerProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed bottom-20 tablet:bottom-6 right-4 z-[60] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(toast.id), 200);
    }, 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  const isError = toast.type === "error";

  return (
    <div
      className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 rounded-card border shadow-lg transition-all duration-200
        ${visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}
        ${isError ? "bg-bad/10 border-bad/30 text-bad" : "bg-ok/10 border-ok/30 text-ok"}`}
    >
      <Icon
        path={isError ? mdiAlertCircleOutline : mdiCheckCircleOutline}
        size={0.8}
        className="shrink-0 mt-0.5"
      />
      <span className="flex-1 text-sm leading-snug">{toast.text}</span>
      <button
        onClick={() => {
          setVisible(false);
          setTimeout(() => onDismiss(toast.id), 200);
        }}
        className="shrink-0 bg-transparent border-none p-0 w-5 h-5 flex items-center justify-center opacity-60 hover:opacity-100 transition-opacity"
      >
        <Icon path={mdiClose} size={0.6} />
      </button>
    </div>
  );
}

let _toastId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((type: "error" | "success", text: string) => {
    const id = `toast-${++_toastId}`;
    setToasts((prev) => [...prev, { id, type, text }]);
  }, []);

  const toastRef = useRef(toast);
  toastRef.current = toast;

  return { toasts, dismiss, toast: toastRef.current };
}
