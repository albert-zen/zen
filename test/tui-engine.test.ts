import { describe, expect, it } from 'vitest';

import { EditorComponent, TextBlock, TuiEngine } from './test-exports.js';
import { VirtualTerminalDevice, waitForRender } from './virtual-terminal.js';

describe('TuiEngine', () => {
  it('renders changed component lines through synchronized diff output', async () => {
    const terminal = new VirtualTerminalDevice(80, 10);
    const engine = new TuiEngine(terminal);
    let text = 'first';

    engine.addChild(new TextBlock(() => [text]));
    engine.start();
    await waitForRender();

    expect(terminal.textOutput()).toContain('first');
    terminal.clearOutput();

    text = 'second';
    engine.requestRender();
    await waitForRender();

    expect(terminal.rawOutput()).toContain('\u001B[?2026h');
    expect(terminal.rawOutput()).toContain('\u001B[2Ksecond');
    expect(terminal.textOutput()).toContain('second');
    engine.stop();
  });

  it('submits editor input and keeps rendering after input', async () => {
    const terminal = new VirtualTerminalDevice(80, 10);
    const engine = new TuiEngine(terminal);
    const editor = new EditorComponent('Ask');
    const submitted: string[] = [];

    editor.onSubmit = (value) => {
      submitted.push(value);
    };
    engine.addChild(editor);
    engine.setFocus(editor);
    engine.start();
    await waitForRender();

    terminal.sendInput('hello');
    terminal.sendInput('\r');
    await waitForRender();

    expect(submitted).toEqual(['hello']);
    expect(terminal.textOutput()).toContain('Ask');
    engine.stop();
  });
});
