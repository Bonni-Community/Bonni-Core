ARG SYNAPSE_BASE_IMAGE=ghcr.io/element-hq/synapse:v1.165.0
FROM ${SYNAPSE_BASE_IMAGE}
COPY bonni_policy.py configure.py /opt/bonni/
ENV PYTHONPATH=/opt/bonni
