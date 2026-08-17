'use client';

import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Trash2,
} from 'lucide-react';

interface CardToolbarProps {
  onEdit?: () => void;
  onDelete?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  showReorder?: boolean;
}

export function CardToolbar({
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst = false,
  isLast = false,
  showReorder = false,
}: CardToolbarProps) {
  return (
    <div className="flex items-center gap-1">
      {showReorder && onMoveUp && (
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 dark:text-lighttext2 hover:text-main transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move up"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      )}
      {showReorder && onMoveDown && (
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 dark:text-lighttext2 hover:text-main transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="Move down"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-500 dark:text-lighttext2 hover:text-main transition-colors"
          title="Edit"
        >
          <Edit3 className="w-4 h-4" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-red-400 hover:text-red-300 transition-colors"
          title="Delete"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
