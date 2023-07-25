FROM node:16-buster AS builder
ENV DEBIAN_FRONTEND noninteractive
ENV DISPLAY :99.0

RUN apt-get -qq update
RUN apt-get install -y --no-install-recommends \
  libuv1-dev libgles2-mesa-dev libglfw3-dev libxi-dev \
  cmake \
  xvfb xauth zip

FROM builder as npm-builder
USER node

VOLUME /aschaffenburg.fun
WORKDIR /aschaffenburg.fun

CMD npm i
