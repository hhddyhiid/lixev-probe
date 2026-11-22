FROM python:3.12-alpine

WORKDIR /app
COPY appserve.py /app/appserve.py

ENV PORT=8080
EXPOSE 8080

# tiny footprint: stdlib only, single process, threaded server
CMD ["python3", "-u", "/app/appserve.py"]
