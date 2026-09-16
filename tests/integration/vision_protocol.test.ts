import { spawn } from 'child_process';
import path from 'path';

describe('vision service subprocess protocol', () => {
  it('exchanges camelCase newline-delimited JSON', async () => {
    const pythonPath = process.env.VISION_PYTHON_PATH
      ?? path.resolve(process.cwd(), 'vision', 'venv', 'Scripts', 'python.exe');
    const proc = spawn(pythonPath, [path.resolve(process.cwd(), 'vision', 'vision_service.py')], {
      env: { ...process.env, VISION_PROTOCOL_TEST: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`vision protocol timeout: ${stderr}`)), 10_000);
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        const newline = stdout.indexOf('\n');
        if (newline >= 0) {
          clearTimeout(timer);
          resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>);
        }
      });
      proc.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    proc.stdin.write(JSON.stringify({
      requestId: 'protocol-1',
      shopId: 'shop1',
      windowHandle: '0x1',
      captureRegion: { x: 0, y: 0, width: 100, height: 100 },
      mode: 'detect_message',
    }) + '\n');

    try {
      await expect(responsePromise).resolves.toMatchObject({
        requestId: 'protocol-1',
        status: 'ok',
        data: { messages: [], inputBox: null, sendButton: null },
      });
    } finally {
      proc.stdin.end();
      proc.kill();
    }
  });
});
