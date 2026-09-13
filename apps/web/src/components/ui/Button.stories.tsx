import type { Meta, StoryObj } from '@storybook/react';
import { en } from '@stark-ballot/web/i18n/translations/en';
import { ja } from '@stark-ballot/web/i18n/translations/ja';
import { Button } from './Button';

const meta = {
  title: 'UI/Button',
  component: Button,
  parameters: { layout: 'centered' },
  args: {
    variant: 'verify',
    children: ja.pages.vote.submit,
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CastVote: Story = {};

export const Unselected: Story = {
  args: { disabled: true },
};

export const Submitting: Story = {
  args: { loading: true, children: ja.pages.vote.submitting },
};

export const CastVoteEnglish: Story = {
  args: { children: en.pages.vote.submit },
};

export const UnselectedEnglish: Story = {
  args: { disabled: true, children: en.pages.vote.submit },
};

export const SubmittingEnglish: Story = {
  args: { loading: true, children: en.pages.vote.submitting },
};
