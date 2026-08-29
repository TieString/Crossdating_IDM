"""Capture COFECHA 6.06 float arrays at its filtering routine boundaries."""

from __future__ import annotations

import argparse
import json
import shutil
import threading
from pathlib import Path

import frida


HOOK_SCRIPT = r"""
const base = Process.mainModule.base;
const calls = { spline: 0, divser: 0, varianceStabilize: 0 };

function readFloatArray(address, length) {
    const values = [];
    for (let index = 0; index < length; index += 1) {
        values.push(address.add(index * 4).readFloat());
    }
    return values;
}

Interceptor.attach(base.add(0xd620), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.source = args[1];
        this.output = args[2];
        this.payload = {
            stage: "spline",
            call: ++calls.spline,
            length: this.length,
            rigidityYears: args[3].readFloat(),
            frequencyResponse: args[4].readFloat(),
            input: readFloatArray(this.source, this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.output, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xe178), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.output = args[3];
        this.payload = {
            stage: "divser",
            call: ++calls.divser,
            length: this.length,
            source: readFloatArray(args[1], this.length),
            curve: readFloatArray(args[2], this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.output, this.length);
        send(this.payload);
    },
});

Interceptor.attach(base.add(0xe4da), {
    onEnter(args) {
        this.length = args[0].readS32();
        this.series = args[1];
        this.payload = {
            stage: "varianceStabilize",
            call: ++calls.varianceStabilize,
            length: this.length,
            rigidityYears: args[2].readS32(),
            input: readFloatArray(this.series, this.length),
        };
    },
    onLeave() {
        this.payload.output = readFloatArray(this.series, this.length);
        send(this.payload);
    },
});
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cofecha-exe", required=True, type=Path)
    parser.add_argument("--rwl", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--job", default="TRACE")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    runtime_name = "INPUT.RWL"
    shutil.copyfile(args.rwl, args.output_dir / runtime_name)

    device = frida.get_local_device()
    records: list[dict[str, object]] = []
    process_output: list[dict[str, object]] = []
    detached = threading.Event()

    def on_output(pid: int, fd: int, data: bytes) -> None:
        process_output.append({
            "pid": pid,
            "fd": fd,
            "text": data.decode("utf-8", errors="replace"),
        })

    device.on("output", on_output)
    pid = device.spawn(
        [str(args.cofecha_exe)],
        cwd=str(args.output_dir),
        stdio="pipe",
    )
    session = device.attach(pid)
    session.on("detached", lambda *_: detached.set())
    script = session.create_script(HOOK_SCRIPT)

    def on_message(message: dict[str, object], _data: bytes | None) -> None:
        if message.get("type") == "send":
            payload = message.get("payload")
            if isinstance(payload, dict):
                records.append(payload)
        else:
            records.append({"stage": "frida-message", "message": message})

    script.on("message", on_message)
    script.load()
    device.resume(pid)
    prompt = "\n".join([
        args.job[:5].upper(),
        runtime_name,
        "",
        "",
        "",
        "3",
        "N",
        "4",
        "N",
        "6",
        "V",
        "",
        "",
    ]).encode("ascii")
    device.input(pid, prompt)
    if not detached.wait(120):
        device.kill(pid)
        raise TimeoutError("COFECHA runtime probe timed out")

    output = {
        "schemaVersion": 1,
        "cofechaExe": str(args.cofecha_exe.resolve()),
        "sourceRwl": str(args.rwl.resolve()),
        "records": records,
        "processOutput": process_output,
    }
    output_path = args.output_dir / "runtime-stages.json"
    output_path.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"COFECHA_RUNTIME_STAGES_COMPLETE {output_path}")


if __name__ == "__main__":
    main()
