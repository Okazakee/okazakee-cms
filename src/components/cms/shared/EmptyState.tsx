'use client';

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, message, action }: EmptyStateProps) {
  return (
    <div className="text-center py-12">
      {Icon && <Icon className="h-12 w-12 mx-auto text-main mb-4" />}
      <p className="text-darktext dark:text-lighttext2 mb-4">{message}</p>
      {action && <div className="flex justify-center">{action}</div>}
    </div>
  );
}
