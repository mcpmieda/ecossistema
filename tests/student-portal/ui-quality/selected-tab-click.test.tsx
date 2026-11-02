// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassTabsV1 } from '../../../src/shared/ui/class-tabs-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';

beforeEach(setupOperationsDomV1);
afterEach(cleanup);

describe('a click on the tab already chosen', () => {
  it('reads nothing again; another tab still changes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ClassTabsV1
        items={[
          { id: 1, label: '6º A' },
          { id: 2, label: '6º B' },
        ]}
        selectedId={1}
        onChange={onChange}
        allLabel="Todas"
      />,
    );

    await user.click(screen.getByRole('tab', { name: '6º A' }));
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: '6º B' }));
    expect(onChange).toHaveBeenCalledWith(2);
  });
});
