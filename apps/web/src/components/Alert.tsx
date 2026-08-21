import type { ReactNode } from 'react';

interface AlertProps {
  children: ReactNode;
  variant?: 'error' | 'info' | 'success';
}

const VARIANT_CLASSES = {
  error: 'bg-red-50 text-red-800 border-red-200',
  info: 'bg-brand-50 text-brand-800 border-brand-200',
  success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
};

export function Alert({ children, variant = 'info' }: AlertProps) {
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={`rounded-md border px-4 py-3 text-sm ${VARIANT_CLASSES[variant]}`}
    >
      {children}
    </div>
  );
}
