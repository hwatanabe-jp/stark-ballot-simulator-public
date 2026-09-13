import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('exposes badge content as an assistive-technology status', () => {
    render(<Badge variant="verified">Status</Badge>);

    expect(screen.getByText('Status')).toHaveAttribute('role', 'status');
  });
});
