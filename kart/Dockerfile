FROM python:3.12-slim
RUN pip install --no-cache-dir pillow==11.3.0
WORKDIR /app
COPY kart.py kart-zemin.png SairaCondensed-ExtraBold.ttf SairaCondensed-Bold.ttf ./
CMD ["python", "kart.py"]
