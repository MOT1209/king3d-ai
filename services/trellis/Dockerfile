# TRELLIS.2 inference service.
#
# One image, two deployment targets: run it locally (GPU on the same machine as
# King3D) or in the cloud - King3D reaches it the same way over HTTP, only
# KING3D_TRELLIS_URL differs.
#
# Base image note: the model needs a CUDA runtime. Swap this base for the
# CUDA/torch base that matches TRELLIS.2's own install instructions once the
# model is wired in (blocked on the licence review in README.md). The slim
# Python base below runs the service shell and the /healthz endpoint, but
# /generate returns 501 until the model stack is added.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py ./

EXPOSE 8900
ENV TRELLIS_MODEL_ID=microsoft/TRELLIS.2

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8900"]
