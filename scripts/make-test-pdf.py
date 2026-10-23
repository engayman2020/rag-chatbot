#!/usr/bin/env python3
"""Generate a small text PDF for testing document upload."""
import sys

lines = [
    "Northwind Return Merchandise Authorization",
    "",
    "An RMA number is required for every hardware return.",
    "RMA numbers are issued by returns@northwind.example within 1 business day.",
    "Returns without an RMA number are refused at the warehouse door.",
    "Items must be in original packaging to be accepted for a return.",
]


def pdf_escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


content = ["BT", "/F1 12 Tf", "72 740 Td", "16 TL"]
for line in lines:
    if not line:
        content.append("T*")
    else:
        content.append(f"({pdf_escape(line)}) Tj")
content.append("ET")
stream = "\n".join(content).encode("latin-1")

objects = []
objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objects.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

out = bytearray(b"%PDF-1.4\n")
offsets = []
for i, obj in enumerate(objects, start=1):
    offsets.append(len(out))
    out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"

xref_at = len(out)
out += f"xref\n0 {len(objects) + 1}\n".encode()
out += b"0000000000 65535 f \n"
for off in offsets:
    out += f"{off:010d} 00000 n \n".encode()
out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()

path = sys.argv[1] if len(sys.argv) > 1 else "returns.pdf"
with open(path, "wb") as fh:
    fh.write(bytes(out))
print(f"wrote {path} ({len(out)} bytes)")
