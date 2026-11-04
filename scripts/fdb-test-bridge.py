"""Test-only JSON transport to a real FoundationDB transaction in Docker.

Production applications should adapt their native binding to OrderedKeyValueDatabase.
This bridge deliberately leaves all patch logic in the TypeScript store under test.
"""
import base64
import json
import sys
import fdb

fdb.api_version(730)
database = fdb.open()
transaction = None

def decode(value):
    return base64.b64decode(value)

def encode(value):
    return base64.b64encode(value).decode("ascii")

for line in sys.stdin:
    request = json.loads(line)
    try:
        op = request["op"]
        if op == "begin":
            transaction = database.create_transaction()
            transaction.options.set_timeout(10000)
            value = None
        elif op == "get":
            data = transaction.get(decode(request["key"])).wait().value
            value = None if data is None else encode(data)
        elif op == "range":
            value = [{"key": encode(item.key), "value": encode(item.value)} for item in
                     transaction.get_range(decode(request["begin"]), decode(request["end"]),
                                           limit=request.get("limit", 0), reverse=request.get("reverse", False))]
        elif op == "set":
            transaction.set(decode(request["key"]), decode(request["value"]))
            value = None
        elif op == "clear":
            transaction.clear(decode(request["key"]))
            value = None
        elif op == "commit":
            transaction.commit().wait()
            transaction = None
            value = None
        elif op == "cancel":
            if transaction is not None:
                transaction.cancel()
            transaction = None
            value = None
        else:
            raise ValueError("Unknown bridge operation")
        print(json.dumps({"id": request["id"], "result": value}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request["id"], "error": str(error), "code": getattr(error, "code", None)}), flush=True)
