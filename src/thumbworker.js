// Worker thread: decodes car thumbnails (BC7, ~250 ms each) off the main thread, so telemetry recording
// and the web server never stall while the garage loads.
import { parentPort } from 'node:worker_threads';
import { renderThumb } from './bc7.js';

parentPort.on('message', ({ id, data, W, H, tw, th }) => {
  try {
    const png = renderThumb(Buffer.from(data.buffer, data.byteOffset, data.byteLength), W, H, tw, th);
    parentPort.postMessage({ id, png });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
