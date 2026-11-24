FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt service.py ./
RUN pip install --no-cache-dir -r requirements.txt
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
ENTRYPOINT ["python", "/app/service.py"]
CMD ["serve"]
