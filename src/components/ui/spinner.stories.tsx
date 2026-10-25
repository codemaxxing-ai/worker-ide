import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { Button } from './button';
import { Collapsible } from './collapsible';
import { Spinner } from './spinner';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Spinner',
	component: Spinner,
	decorators: [
		(Story) => (
			<div className="flex min-h-utility-panel items-center justify-center p-8">
				<Story />
			</div>
		),
	],
	argTypes: {
		size: {
			control: 'select',
			options: ['xs', 'sm', 'md', 'lg', 'xl'],
		},
	},
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectSpinnerToAnimate(spinner: HTMLElement) {
	const path = spinner.querySelector('path');
	if (!path) throw new Error('Spinner path not found');

	const initialTransform = getComputedStyle(spinner).transform;
	const initialStrokeDashoffset = getComputedStyle(path).strokeDashoffset;
	await waitFor(async () => {
		await expect(getComputedStyle(spinner).transform).not.toBe(initialTransform);
		await expect(getComputedStyle(path).strokeDashoffset).not.toBe(initialStrokeDashoffset);
	});
}

export const Default: Story = {
	args: {
		size: 'md',
	},
	play: async ({ canvasElement }) => {
		await expectSpinnerToAnimate(within(canvasElement).getByRole('status'));
	},
};

export const InitiallyOpenCollapsible: Story = {
	render: () => (
		<Collapsible open>
			<div className="flex items-center gap-2">
				<Spinner size="xs" />
				<span>Connection lost. Reconnecting…</span>
			</div>
		</Collapsible>
	),
	play: async ({ canvasElement }) => {
		await expectSpinnerToAnimate(within(canvasElement).getByRole('status'));
	},
};

export const LoadingButtonInsidePresence: Story = {
	render: function Render() {
		const [isStopping, setIsStopping] = useState(false);
		return (
			<AnimatePresence initial={false}>
				<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
					<Button id="spinner-stop-generation" isLoading={isStopping} onClick={() => setIsStopping(true)}>
						Stop generation
					</Button>
				</motion.div>
			</AnimatePresence>
		);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Stop generation' }));
		await expectSpinnerToAnimate(canvas.getByRole('status'));
	},
};

export const ExtraSmall: Story = {
	args: {
		size: 'xs',
	},
};

export const Small: Story = {
	args: {
		size: 'sm',
	},
};

export const Large: Story = {
	args: {
		size: 'lg',
	},
};

export const ExtraLarge: Story = {
	args: {
		size: 'xl',
	},
};

export const AllSizes: Story = {
	render: () => (
		<div className="flex items-center gap-4">
			<Spinner size="xs" />
			<Spinner size="sm" />
			<Spinner size="md" />
			<Spinner size="lg" />
			<Spinner size="xl" />
		</div>
	),
};

export const CustomColors: Story = {
	render: () => (
		<div className="flex items-center gap-4 text-accent">
			<Spinner size="md" />
			<Spinner size="md" className="text-warning" />
			<Spinner size="md" className="text-success" />
			<Spinner size="md" className="text-error" />
		</div>
	),
};
