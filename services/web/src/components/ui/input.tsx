import * as React from 'react'
import { cn } from '@/shared/utils'

const fieldCls =
  'w-full min-w-0 rounded-lg border border-input bg-card text-sm shadow-xs transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground/80 hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/15 dark:bg-white/[0.03]'

export function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldCls, 'flex h-9 px-3 py-1', className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(fieldCls, 'flex min-h-16 px-3 py-2', className)} {...props} />
}

export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(fieldCls, 'flex h-9 px-2.5 py-1', className)} {...props} />
}

export function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium leading-none select-none', className)} {...props} />
}

export function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" className={cn('size-4 cursor-pointer rounded border-input accent-[var(--primary)]', className)} {...props} />
}
