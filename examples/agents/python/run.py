import json
import os
import sys
import uuid

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.trace import Status, StatusCode


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


service_name = required("OTEL_SERVICE_NAME")
environment = required("DEPLOYMENT_ENVIRONMENT")
tenant_id = required("TRACEY_TENANT_ID")
agent_name = required("TRACEY_AGENT_NAME")
endpoint = required("OTEL_EXPORTER_OTLP_ENDPOINT").rstrip("/") + "/v1/traces"
prompt = " ".join(sys.argv[1:]) or "Summarize the active support queue"
answer = "There are 3 active support tickets."

provider = TracerProvider(resource=Resource.create({
    "service.name": service_name,
    "service.version": "1.0.0",
    "deployment.environment.name": environment,
    "tracey.tenant.id": tenant_id,
}))
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
trace.set_tracer_provider(provider)
tracer = trace.get_tracer("tracey.sample.python", "1.0.0")
run_id = "python-" + uuid.uuid4().hex

with tracer.start_as_current_span("agent.run") as run:
    run.set_attributes({
        "tracey.run.id": run_id,
        "tracey.agent.name": agent_name,
        "tracey.agent.version": "1.0.0",
        "tracey.user.outcome": "resolved",
        "tracey.content.capture": "full",
        "tracey.content.input": prompt,
        "tracey.content.output": answer,
    })
    with tracer.start_as_current_span("retrieval support-knowledge") as retrieval:
        retrieval.set_attributes({
            "gen_ai.operation.name": "retrieval",
            "tracey.retriever.name": "support-knowledge",
            "tracey.result.count": 1,
            "tracey.result.max_score": 0.94,
        })
    with tracer.start_as_current_span("chat openai/gpt-5-mini") as model:
        model.set_attributes({
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": "openai",
            "gen_ai.request.model": "gpt-5-mini",
            "gen_ai.response.model": "gpt-5-mini-2025-08-07",
            "gen_ai.usage.input_tokens": 18,
            "gen_ai.usage.output_tokens": 11,
            "tracey.cost.usd": 0.0000093,
            "tracey.content.capture": "full",
            "tracey.content.input": prompt,
            "tracey.content.output": "I should inspect the support queue.",
        })
    with tracer.start_as_current_span("execute_tool list_tickets") as tool:
        tool.set_attributes({
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "list_tickets",
            "tracey.tool.side_effect": "read",
            "tracey.tool.result.class": "success",
            "tracey.content.capture": "full",
            "tracey.content.input": '{"status":"active"}',
            "tracey.content.output": '{"count":3}',
        })
    run.set_status(Status(StatusCode.OK))

trace_id = format(run.get_span_context().trace_id, "032x")
provider.shutdown()
print(json.dumps({"runId": run_id, "traceId": trace_id, "serviceName": service_name}))
