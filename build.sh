mkdir -p bin

go build -C ./analyzer -o ../bin/gomu-linux-x64

chmod +x ./bin/gomu-linux-x64