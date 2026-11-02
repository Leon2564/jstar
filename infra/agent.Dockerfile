FROM python:3.12-slim
WORKDIR /srv
COPY apps/agent/pyproject.toml ./
RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic pyyaml httpx
COPY apps/agent/app ./app
ENV PYTHONUNBUFFERED=1
EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
