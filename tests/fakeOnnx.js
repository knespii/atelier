// A tiny made-up model in place of u2netp, for the depth worker's tests:
// the same input and output as u2netp's (1×3×320×320 in, 1×1×320×320 out),
// what stands out being simply what is bright – the mean of the channels,
// through a sigmoid. Written as ONNX's protobuf by hand: no onnx package
// needed, nothing downloaded.

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

// ValueInfoProto: a float tensor of a shape.
const tensor = (name, shape) => [
    ...bytes(1, name),
    ...bytes(2, bytes(1, [...number(1, 1), ...bytes(2, shape.flatMap(d => bytes(1, number(1, d))))])),
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
export function fakeU2netp() {
    // AttributeProto: axes = [1] (INTS), keepdims = 1 (INT).
    const axes = [...bytes(1, 'axes'), ...number(8, 1), ...number(20, 7)];
    const keepdims = [...bytes(1, 'keepdims'), ...number(3, 1), ...number(20, 2)];
    const graph = [
        ...bytes(1, node('ReduceMean', ['input.1'], ['mean'], [axes, keepdims])),
        ...bytes(1, node('Sigmoid', ['mean'], ['d0'])),
        ...bytes(2, 'fake-u2netp'),
        ...bytes(11, tensor('input.1', [1, 3, 320, 320])),
        ...bytes(12, tensor('d0', [1, 1, 320, 320])),
    ];
    return new Uint8Array([
        ...number(1, 7), // ir_version
        ...bytes(2, 'atelier-tests'),
        ...bytes(7, graph),
        ...bytes(8, [...bytes(1, ''), ...number(2, 13)]), // opset 13
    ]);
}
