import { EventEmitter } from 'events';
import type { IWebContents, IWebviewManager, LoginStatus } from './types';

class HeadlessWebContents extends EventEmitter implements IWebContents {
  async executeJavaScript(): Promise<unknown> {
    throw new Error('webview is unavailable in headless mode');
  }

  async sendInputEvent(): Promise<void> {}
  isDestroyed(): boolean { return false; }
  isCrashed(): boolean { return false; }
  async loadURL(): Promise<void> {}
  getURL(): string { return 'about:blank'; }
  async reload(): Promise<void> {}
}

/** Keeps the CLI backend operational without pretending that a browser view exists. */
export class HeadlessWebviewManager implements IWebviewManager {
  private readonly contents = new Map<string, HeadlessWebContents>();
  private activeShopId: string | null = null;

  async ensureView(shopId: string): Promise<IWebContents> {
    let contents = this.contents.get(shopId);
    if (!contents) {
      contents = new HeadlessWebContents();
      this.contents.set(shopId, contents);
    }
    return contents;
  }

  removeView(shopId: string): void { this.contents.delete(shopId); }
  getLoginStatus(): LoginStatus { return 'logged_out'; }
  setLoginStatus(): void {}
  getActiveShopId(): string | null { return this.activeShopId; }
  setActiveShopId(shopId: string | null): void { this.activeShopId = shopId; }
  async ensureAndMount(shopId: string): Promise<void> {
    await this.ensureView(shopId);
    this.activeShopId = shopId;
  }
  getAllShopIds(): string[] { return Array.from(this.contents.keys()); }
  async refreshSession(): Promise<void> {}
  async forceReLogin(): Promise<void> {}
  reloadShop(): void {}
  async scrapeUrlInHiddenWindow(): Promise<unknown> {
    throw new Error('scrapeUrlInHiddenWindow is unavailable in headless mode');
  }

  async diagnoseWithNetworkCapture(): Promise<{ scriptResult: unknown; apiRequests: never[] }> {
    throw new Error('diagnoseWithNetworkCapture is unavailable in headless mode');
  }
}
