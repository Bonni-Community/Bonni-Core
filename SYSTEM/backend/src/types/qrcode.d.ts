declare module "qrcode" {
  export type QrCodeRenderOptions = {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H" | "low" | "medium" | "quartile" | "high";
    margin?: number;
    width?: number;
    type?: string;
  };

  export function toDataURL(text: string, options?: QrCodeRenderOptions): Promise<string>;
  export function toString(text: string, options?: QrCodeRenderOptions & { type?: "svg" | "terminal" | "utf8" }): Promise<string>;
}
