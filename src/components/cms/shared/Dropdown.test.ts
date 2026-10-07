// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dropdown, type DropdownOption, type DropdownProps } from './Dropdown';

const baseOptions: DropdownOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry' },
];

function makeProps(overrides: Partial<DropdownProps> = {}): DropdownProps {
  return {
    value: 'b',
    options: baseOptions,
    onChange: () => {},
    id: 'fruit',
    ...overrides,
  };
}

function findTrigger(): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>('[role="combobox"]');
  if (!node) throw new Error('Missing dropdown trigger');
  return node;
}

function findOpenListbox(): HTMLElement {
  const node = document.querySelector<HTMLElement>('[role="listbox"]');
  if (!node) throw new Error('Dropdown menu is not open');
  return node;
}

function findOptionRows(): HTMLElement[] {
  const nodes = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  if (nodes.length === 0) throw new Error('Dropdown renders no options');
  return nodes;
}

let container: HTMLDivElement;
let root: Root;

async function mount(props: Partial<DropdownProps> = {}): Promise<DropdownProps> {
  const resolved = makeProps(props);
  await act(async () => {
    root.render(createElement(Dropdown, resolved) as ReactElement);
  });
  return resolved;
}

async function press(node: Element, keyName: string) {
  await act(async () => {
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: keyName, bubbles: true })
    );
  });
}

async function click(node: Element) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Dropdown static markup', () => {
  it('renders the selected label on a closed combobox trigger', () => {
    const html = renderToStaticMarkup(
      createElement(Dropdown, makeProps({ label: 'Fruit' }))
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
    // No dangling reference: the trigger points at the listbox only while the
    // listbox exists.
    expect(html).not.toContain('aria-controls');
    expect(html).toContain('aria-label="Fruit"');
    expect(html).toContain('Banana');
    expect(html).not.toContain('role="listbox"');
  });

  it('falls back to the placeholder when nothing matches', () => {
    const html = renderToStaticMarkup(
      createElement(Dropdown, makeProps({ value: '', placeholder: 'Pick one' }))
    );
    expect(html).toContain('Pick one');
    expect(html).not.toContain('Banana');
  });
});

describe('Dropdown interaction', () => {
  it('exposes the selected label with aria-expanded false', async () => {
    await mount();
    expect(findTrigger().textContent).toContain('Banana');
    expect(findTrigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('opens on click and on ArrowDown', async () => {
    await mount();
    await click(findTrigger());
    expect(findTrigger().getAttribute('aria-expanded')).toBe('true');
    expect(findOptionRows()).toHaveLength(3);

    await press(findTrigger(), 'Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await press(findTrigger(), 'ArrowDown');
    expect(findOpenListbox()).not.toBeNull();
  });

  it('moves the active row with ArrowDown, Home and End', async () => {
    await mount();
    await click(findTrigger());
    // Opens on the selected row.
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-1'
    );

    await press(findTrigger(), 'ArrowDown');
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-2'
    );

    await press(findTrigger(), 'Home');
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-0'
    );

    await press(findTrigger(), 'End');
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-2'
    );
  });

  it('selects with Enter, calls onChange once, closes and refocuses', async () => {
    const onChange = vi.fn();
    await mount({ onChange });
    await click(findTrigger());
    await press(findTrigger(), 'ArrowDown');
    await press(findTrigger(), 'Enter');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('c');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(findTrigger());
  });

  it('closes on Escape without calling onChange', async () => {
    const onChange = vi.fn();
    await mount({ onChange });
    await click(findTrigger());
    await press(findTrigger(), 'Escape');

    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(findTrigger());
  });

  it('closes on an outside pointerdown', async () => {
    await mount();
    await click(findTrigger());
    expect(findOpenListbox()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('does not open while disabled', async () => {
    await mount({ disabled: true });
    await click(findTrigger());
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await press(findTrigger(), 'ArrowDown');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(findTrigger().disabled).toBe(true);
  });

  it('skips a disabled option and refuses to select it', async () => {
    const onChange = vi.fn();
    await mount({
      value: 'a',
      onChange,
      options: [
        { value: 'a', label: 'Apple' },
        { value: 'b', label: 'Banana', disabled: true },
        { value: 'c', label: 'Cherry' },
      ],
    });
    await click(findTrigger());
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-0'
    );

    await press(findTrigger(), 'ArrowDown');
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-2'
    );

    const disabledRow = findOptionRows()[1];
    expect(disabledRow.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      disabledRow.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true })
      );
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(findOpenListbox()).not.toBeNull();
  });

  it('jumps to the first label matching a typeahead buffer', async () => {
    await mount({ value: 'a' });
    await click(findTrigger());
    await press(findTrigger(), 'c');
    expect(findTrigger().getAttribute('aria-activedescendant')).toBe(
      'fruit-listbox-2'
    );
  });
});
