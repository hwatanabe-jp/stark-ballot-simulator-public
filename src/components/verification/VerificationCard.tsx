'use client';

import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/Card';

interface VerificationCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Card title */
  title: string;
  /** Whether the verification passed */
  verified?: boolean;
  /** Card content */
  children: ReactNode;
  /** Optional footer content */
  footer?: ReactNode;
  /** Additional CSS classes */
}

/**
 * Verification Card - Card with stamp decoration for completed verification
 *
 * Design spec (design-spec-transparent-trust.md):
 * - Uses Card variant="verification"
 * - Verified state shows stamp in top-right corner
 * - Stamp animation is automatic when verified
 */
export function VerificationCard({
  title,
  verified = false,
  children,
  footer,
  className = '',
  ...props
}: VerificationCardProps): ReactElement {
  return (
    <Card variant="verification" verified={verified} className={className} {...props}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && <CardFooter>{footer}</CardFooter>}
    </Card>
  );
}
