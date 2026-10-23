// A tiny made-up model in place of Depth Anything V2, for the depth
// worker's tests: the same input and output as the real one's (1×3×H×W in,
// any size; 1×H×W out), how near a pixel is being simply how bright it is –
// the mean of the channels, so the brighter, the nearer. Written as ONNX's
// protobuf by hand: no onnx package needed, nothing downloaded.

const encoder = new TextEncoder();

function varint(value) {
    const bytes = [];
    let v = BigInt(value);
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n)
            byte |= 0x80;
        bytes.push(byte);
    } while (v > 0n);
    return bytes;
}

const number = (field, value) => [...varint(field << 3), ...varint(value)];

function bytes(field, content) {
    const data = typeof content === 'string' ? [...encoder.encode(content)] : content;
    return [...varint((field << 3) | 2), ...varint(data.length), ...data];
}

// ValueInfoProto: a float tensor of a shape (a number for a fixed side, a
// name for one of any size).
const dimension = d => bytes(1, typeof d === 'string' ? bytes(2, d) : number(1, d));
const tensor = (name, shape) => [
    ...bytes(1, name),
    ...bytes(2, bytes(1, [...number(1, 1), ...bytes(2, shape.flatMap(dimension))])),
];

// NodeProto
const node = (op, inputs, outputs, attributes = []) => [
    ...inputs.flatMap(name => bytes(1, name)),
    ...outputs.flatMap(name => bytes(2, name)),
    ...bytes(3, `${op}-node`),
    ...bytes(4, op),
    ...attributes.flatMap(attribute => bytes(5, attribute)),
];

/** @returns {Uint8Array} the model, as an .onnx file has it */
export function fakeDepthModel() {
    // AttributeProto: axes = [1] (INTS), keepdims = 0 (INT).
    const axes = [...bytes(1, 'axes'), ...number(8, 1), ...number(20, 7)];
    const keepdims = [...bytes(1, 'keepdims'), ...number(3, 0), ...number(20, 2)];
    const graph = [
        ...bytes(1, node('ReduceMean', ['pixel_values'], ['predicted_depth'], [axes, keepdims])),
        ...bytes(2, 'fake-depth-anything'),
        ...bytes(11, tensor('pixel_values', ['batch', 3, 'height', 'width'])),
        ...bytes(12, tensor('predicted_depth', ['batch', 'height', 'width'])),
    ];
    return new Uint8Array([
        ...number(1, 7), // ir_version
        ...bytes(2, 'atelier-tests'),
        ...bytes(7, graph),
        ...bytes(8, [...bytes(1, ''), ...number(2, 13)]), // opset 13
    ]);
}
