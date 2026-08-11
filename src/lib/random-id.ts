import crypto from 'node:crypto';

/**
 * Generates a crypto random, 32-bit, number.
 */
export default function randomId(): number {
    const buffer = crypto.randomBytes(4);
    const randomNumber = buffer.readUint32BE(0) & 0x7FFFFF; // limit to 23 bits to stay in range
    const timestamp = (Date.now() & 0xFFFFFFFFFF) >>> 0; // masked to 32-bit

    // Divide the timestamp into 23-bit parts to stay within range
    const highPart = (timestamp / 0x100000) >>> 0;
    const lowPart = (timestamp & 0x7FFFFF) >>> 0;

    // Combine parts and limit the result to 31 bits (positive range of a signed 32-bit integer)
    return (((highPart << 23) | lowPart) ^ randomNumber) & 0x7FFFFFFF; // 31-bit mask
}