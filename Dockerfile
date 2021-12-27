FROM node:14-alpine 
COPY ./server /app

WORKDIR  /app

RUN yarn 
CMD ["yarn", "start"]