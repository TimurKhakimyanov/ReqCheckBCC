import { Tabs as TabsPrimitive } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/shared/utils'

export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-9 items-center gap-0.5 rounded-[10px] bg-muted p-0.5 text-muted-foreground shadow-inset', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-[450] whitespace-nowrap transition-all outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-card dark:data-[state=active]:bg-accent',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />
}
