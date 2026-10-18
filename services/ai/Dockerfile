FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY huddle_ai huddle_ai
RUN pip install --no-cache-dir ".[speech]"
ENV WHISPER_MODEL=small
EXPOSE 8790
CMD ["uvicorn", "huddle_ai.app:app", "--host", "0.0.0.0", "--port", "8790"]
