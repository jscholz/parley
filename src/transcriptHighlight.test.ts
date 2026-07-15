import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearHighlight,
  initTranscriptHighlight,
} from './transcriptHighlight.ts';

class FakeClassList {
  private values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(name);
    if (next) this.values.add(name);
    else this.values.delete(name);
    return next;
  }
}

class FakeElement extends EventTarget {
  tagName = 'DIV';
  className = '';
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  isContentEditable = false;
  innerHTML = '';
  textContent = '';

  setAttribute(): void {}
  appendChild(): void {}
  focus(): void {}
  scrollIntoView(): void {}
  querySelector(): null { return null; }
  querySelectorAll(): FakeElement[] { return []; }
  getBoundingClientRect(): DOMRect {
    return { top: 100, bottom: 140, left: 20, width: 200 } as DOMRect;
  }
}

class FakeComposer extends FakeElement {
  override tagName = 'TEXTAREA';
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
}

class FakeTranscript extends FakeElement {
  private readonly rows: FakeElement[];

  constructor(rows: FakeElement[]) {
    super();
    this.rows = rows;
  }

  override querySelectorAll(): FakeElement[] {
    return this.rows;
  }
}

class FakeDocument extends EventTarget {
  body = new FakeElement();

  createElement(): FakeElement {
    return new FakeElement();
  }
}

function bareArrowUp(): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperties(event, {
    key: { value: 'ArrowUp' },
    metaKey: { value: false },
    ctrlKey: { value: false },
    shiftKey: { value: false },
    altKey: { value: false },
  });
  return event;
}

it('enters transcript highlight from a non-empty composer when the caret is at top-left', () => {
  Object.defineProperty(globalThis, 'document', {
    value: new FakeDocument(),
    configurable: true,
  });

  const composer = new FakeComposer();
  composer.value = 'draft text\nsecond line';
  composer.selectionStart = 0;
  composer.selectionEnd = 0;

  const latestBubble = new FakeElement();
  latestBubble.dataset.messageId = 'm-latest';
  const transcript = new FakeTranscript([latestBubble]);

  initTranscriptHighlight({
    composer: composer as unknown as HTMLTextAreaElement,
    transcript: transcript as unknown as HTMLElement,
  });

  const event = bareArrowUp();
  composer.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(latestBubble.classList.contains('transcript-highlight'), true);
  clearHighlight();
});

it('leaves ArrowUp to the textarea when a non-empty composer caret is not at top-left', () => {
  Object.defineProperty(globalThis, 'document', {
    value: new FakeDocument(),
    configurable: true,
  });

  const composer = new FakeComposer();
  composer.value = 'draft text';
  composer.selectionStart = 5;
  composer.selectionEnd = 5;

  const latestBubble = new FakeElement();
  latestBubble.dataset.messageId = 'm-latest';
  const transcript = new FakeTranscript([latestBubble]);

  initTranscriptHighlight({
    composer: composer as unknown as HTMLTextAreaElement,
    transcript: transcript as unknown as HTMLElement,
  });

  const event = bareArrowUp();
  composer.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(latestBubble.classList.contains('transcript-highlight'), false);
  clearHighlight();
});

it('leaves ArrowUp to the textarea when text is selected from index zero', () => {
  Object.defineProperty(globalThis, 'document', {
    value: new FakeDocument(),
    configurable: true,
  });

  const composer = new FakeComposer();
  composer.value = 'draft text';
  composer.selectionStart = 0;
  composer.selectionEnd = 5;

  const latestBubble = new FakeElement();
  latestBubble.dataset.messageId = 'm-latest';
  const transcript = new FakeTranscript([latestBubble]);

  initTranscriptHighlight({
    composer: composer as unknown as HTMLTextAreaElement,
    transcript: transcript as unknown as HTMLElement,
  });

  const event = bareArrowUp();
  composer.dispatchEvent(event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(latestBubble.classList.contains('transcript-highlight'), false);
  clearHighlight();
});
