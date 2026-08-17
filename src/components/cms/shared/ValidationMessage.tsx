'use client';

interface ValidationMessageProps {
  message: string | null | undefined;
  show?: boolean;
}

export function ValidationMessage({ message, show = true }: ValidationMessageProps) {
  if (!message || !show) return null;

  return (
    <p className="mt-1 text-xs text-red-500" role="alert">
      {message}
    </p>
  );
}
