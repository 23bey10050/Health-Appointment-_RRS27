import { useId, type InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
}

/** A real `<label>`, tied to the input by a generated id, every time - never a placeholder
 *  standing in for one. A placeholder disappears the moment someone starts typing, which is
 *  exactly the moment a screen reader user still needs to know what field they are in. */
export function Input({ label, error, id, className = '', ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`rounded-md border px-3 py-2 text-sm focus-visible:ring-1 ${error ? 'border-red-400' : 'border-slate-300'} ${className}`}
        {...rest}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
