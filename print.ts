import { Printer, Image } from "@node-escpos/core";
import sharp from "sharp";
import { join } from "path";
import { mkdir } from "fs/promises";
import net from "net";
import fetch from "node-fetch";

import USB from "@node-escpos/usb-adapter";
import Network from "@node-escpos/network-adapter";

type ConnectionType = "usb" | "network";
type PrinterClient = USB | Network;

export class PrinterConnection {
  private static instance: PrinterConnection;
  public readonly client: PrinterClient;
  public readonly printer: Printer<[]>;
  private _socket?: net.Socket;
  public readonly connectionType: ConnectionType;

  private constructor(connectionType: ConnectionType) {
    this.connectionType = connectionType;
    this.client =
      connectionType === "usb"
        ? new USB()
        : new Network(process.env.PRINTER_IP!);
    this.printer = new Printer(this.client, {});

    if (connectionType === "network") {
      this._socket = new net.Socket();
      this._socket.connect(9100, process.env.PRINTER_IP!, () => {
        console.log("[🧾] Printer network connected");
      });
    }
  }

  static getInstance(): PrinterConnection {
    if (!PrinterConnection.instance) {
      // Defaulting to network; switch to "usb" if needed.
      PrinterConnection.instance = new PrinterConnection("usb");
    }
    return PrinterConnection.instance;
  }

  async printMessage(name: string, text: string) {
    console.log(`Printing message from ${name}: ${text}`);
    await new Promise<void>((resolve) => this.client.open(resolve));

    // Print a line with the display name (in bold) and tweet text.
    this.printer
      .font("a")
      .align("lt")
      .style("b")
      .size(1, 1)
      .text(`${name}: ${text}`);

    // Ensure a minimum length (approx. 10 cm, 800 dots)
    await this.ensureMinimumLength(800);

    this.printer.cut();

    await this.printer.flush();
    this.client.close();
  }

  async printImage(imagePath: string) {
    console.log(`Attempting to print image from path: ${imagePath}`);
    await new Promise<void>((resolve) => this.client.open(resolve));
    try {
      const image = await Image.load(imagePath);
      await this.printer.image(image, "d24");
      this.printer.cut();

      if (this.connectionType === "usb") {
        await this.printer.flush();
        this.client.close();
      } else {
        const buf = this.printer.buffer.flush();
        this._socket!.write(buf);
      }
    } catch (error) {
      console.error("Error during image printing:", error);
    }
  }

  private async ensureMinimumLength(minDots: number) {
    // Assuming each feed line is ~24 dots, calculate the needed number of feed lines.
    const linesNeeded = Math.ceil(minDots / 24);
    this.printer.feed(linesNeeded);
  }
}

export async function downloadAndProcessImage(url: string): Promise<string> {
  console.log(`Downloading image from URL: ${url}`);
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`Image downloaded, applying dithering`);

  const ditheredBuffer = await applyDithering(buffer);
  console.log(`Dithering applied`);

  // Create a temporary file path in the "temp" folder.
  const tempDir = join(process.cwd(), "temp");
  await mkdir(tempDir, { recursive: true });
  const tempFilePath = join(tempDir, `temp_image_${Date.now()}.png`);

  // Save the processed image.
  await sharp(ditheredBuffer).png().toFile(tempFilePath);
  console.log(`Processed image saved to: ${tempFilePath}`);

  return tempFilePath;
}

async function applyDithering(inputBuffer: Buffer): Promise<Buffer> {
  const floydSteinberg = (
    imageData: Uint8Array,
    width: number,
    height: number,
  ) => {
    const newImageData = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const oldPixel = imageData[i];
        const newPixel = oldPixel < 128 ? 0 : 255;
        newImageData[i] = newPixel;
        const error = oldPixel - newPixel;

        if (x + 1 < width) {
          imageData[i + 1] += (error * 7) / 16;
        }
        if (x > 0 && y + 1 < height) {
          imageData[i + width - 1] += (error * 3) / 16;
        }
        if (y + 1 < height) {
          imageData[i + width] += (error * 5) / 16;
        }
        if (x + 1 < width && y + 1 < height) {
          imageData[i + width + 1] += (error * 1) / 16;
        }
      }
    }

    return newImageData;
  };

  const { data, info } = await sharp(inputBuffer)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ditheredBuffer = floydSteinberg(
    new Uint8Array(data),
    info.width,
    info.height,
  );

  return sharp(ditheredBuffer, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  })
    .png()
    .toBuffer();
}

// If run directly, execute a demo.
if (import.meta.main) {
  (async () => {
    console.log("z_print.ts loaded, running test print...");
    const printerConnection = PrinterConnection.getInstance();

    // Demo: print a test message.
    await printerConnection.printMessage("Test User", "Hello via Bun!");

    // Demo: download and print an image.
    const imageUrl =
      "https://pbs.twimg.com/profile_images/1248374454436032520/8VSGS2ta_400x400.jpg";
    const imagePath = await downloadAndProcessImage(imageUrl);
    await printerConnection.printImage(imagePath);
  })();
}
