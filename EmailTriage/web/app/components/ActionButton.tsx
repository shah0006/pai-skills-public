"use client";
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

/**
 * ActionButton — Ethos brand pattern adapted for a dark, dense surface.
 * Default rest = charcoal fill + gold hairline + gold text.
 * Hover flips: gold fill + charcoal text.
 *
 * NOTE: page.tsx is currently inline-styled (not Tailwind-utility-class based);
 * this component is scaffolding for the future Tailwind refactor (Phase 25.1+).
 * Available for use in NEW components added to web/app/components/.
 */
const actionButtonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md font-sans font-medium",
    "transition-colors duration-150 ease-out",
    "focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2",
    "focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:   "bg-gold text-charcoal border border-gold hover:bg-muted-gold",
        secondary: "bg-surface text-gold border border-gold/70 hover:bg-gold hover:text-charcoal",
        ghost:     "text-gold hover:bg-surface-2 hover:text-muted-gold",
        kbd:       "bg-surface-2 text-text-muted border border-border-subtle font-mono hover:text-gold hover:border-gold/60",
        danger:    "bg-muted-rose/20 text-muted-rose border border-muted-rose/70 hover:bg-muted-rose hover:text-charcoal",
      },
      size: {
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3 text-[13px]",
        lg: "h-10 px-4 text-[14px]",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  }
);

export interface ActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof actionButtonVariants> {
  shortcut?: string;
}

export const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  ({ className, variant, size, shortcut, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(actionButtonVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      {shortcut && (
        <kbd className="ml-1 font-mono text-[11px] opacity-70">{shortcut}</kbd>
      )}
    </button>
  )
);
ActionButton.displayName = "ActionButton";
